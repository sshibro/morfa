//! One socket (docs/BACKEND.md §2 "The socket"): `hello` with the ticket first, then a reader that decodes
//! frames off the actor (decode never runs inside it), applies the per-connection rate limits and forwards
//! typed messages into the actor's bounded inbox; and a writer task that drains the connection's [`Outbox`].

use crate::actor::{ActorMsg, JoinRequest, Joined};
use crate::backpressure::{Next, Out, Outbox};
use crate::metrics::metrics;
use crate::router::App;
use crate::ws::{self, Incoming};
use bytes::Bytes;
use morfa_protocol::{ByeReason, ClientMsg, Codec, ErrorCode, Hello, Seq, ServerMsg, Wire, limits};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::oneshot;
use tokio::time::timeout;

/// A token bucket: `rate` per second, bursts of twice that.
struct Bucket {
    tokens: f64,
    rate: f64,
    last: Instant,
}

impl Bucket {
    fn new(rate: u32) -> Self {
        Bucket {
            tokens: 2.0 * rate as f64,
            rate: rate as f64,
            last: Instant::now(),
        }
    }
    fn take(&mut self, n: f64) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.rate)
            .min(2.0 * self.rate);
        self.last = now;
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }
}

async fn write_loop(socket: Arc<ws::Writer>, outbox: Arc<Outbox>, codec: &'static dyn Codec) {
    let mut chunks: Vec<Bytes> = Vec::new();
    let add = |chunks: &mut Vec<Bytes>, next: Next| -> bool {
        let out = match next {
            Next::Frame(out) => {
                metrics().bytes_out_total.add(out.len() as u64);
                out
            }
            Next::Raw(bytes) => {
                chunks.push(bytes);
                return false;
            }
            Next::CatchUp { from, to } => {
                Out::from(codec.encode_server(&ServerMsg::CatchUp { from, to }))
            }
            Next::Bye(reason) => {
                chunks.extend(Out::from(codec.encode_server(&ServerMsg::Bye { reason })).framed());
                chunks.extend(Out::close(1000, "bye").framed());
                return true;
            }
        };
        chunks.extend(out.framed());
        false
    };
    loop {
        let mut closing = add(&mut chunks, outbox.next().await);
        // Whatever else is queued goes in the same write.
        while !closing && chunks.len() < 128 {
            let Some(next) = outbox.try_next() else { break };
            closing = add(&mut chunks, next);
        }
        if socket.write_all(&mut chunks).await.is_err() || closing {
            return;
        }
        outbox.written();
    }
}

/// The `seq` of an op too large to read whole.
fn seq_of(bytes: &[u8]) -> Option<Seq> {
    #[derive(serde::Deserialize)]
    struct SeqOnly {
        seq: Seq,
    }
    serde_json::from_slice::<SeqOnly>(bytes).ok().map(|s| s.seq)
}

async fn read_hello(reader: &mut ws::Reader, codec: &dyn Codec, outbox: &Outbox) -> Option<Hello> {
    loop {
        let bytes = match reader.next().await {
            Ok(Some(Incoming::Text(bytes) | Incoming::Binary(bytes))) => bytes,
            Ok(Some(Incoming::Ping(payload))) => {
                outbox.push(Out::pong(payload));
                continue;
            }
            Ok(Some(Incoming::Pong)) => continue,
            _ => return None,
        };
        return match codec.decode_client(&bytes) {
            Ok(ClientMsg::Hello(hello)) => Some(hello),
            _ => None,
        };
    }
}

pub async fn serve(
    app: App,
    file: String,
    wire: Wire,
    origin: Option<String>,
    mut reader: ws::Reader,
    socket: Arc<ws::Writer>,
) {
    let config = &app.shared.config;
    let codec = wire.codec();
    let outbox = Arc::new(Outbox::with_socket(
        config.send_queue_bytes,
        Arc::clone(&socket),
    ));
    // Counted while it runs: a drain waits for the writers' last frames (crate::drain).
    let writing = {
        let counted = app.drain.socket();
        let writing = write_loop(socket, Arc::clone(&outbox), codec);
        async move {
            let _counted = counted;
            writing.await
        }
    };
    let writer = match &app.writers {
        Some(writers) => writers.spawn(writing),
        None => tokio::spawn(writing),
    };
    let close = |reason: ByeReason, code: Option<ErrorCode>| {
        if let Some(code) = code {
            outbox.push(codec.encode_server(&ServerMsg::Error {
                code,
                message: None,
            }));
        }
        outbox.close_after_queued(reason);
    };

    let hello = match timeout(
        config.hello_timeout,
        read_hello(&mut reader, codec, &outbox),
    )
    .await
    {
        Ok(Some(hello)) => hello,
        _ => {
            close(ByeReason::Protocol, Some(ErrorCode::BadMessage));
            let _ = writer.await;
            return;
        }
    };
    if !hello.protocol_ok() || !hello.client_id.is_valid() {
        close(ByeReason::Protocol, Some(ErrorCode::BadMessage));
        let _ = writer.await;
        return;
    }
    let claims = match config
        .tickets
        .verify(&hello.ticket, &file, origin.as_deref())
    {
        Ok(claims) => claims,
        Err(error) => {
            tracing::debug!(file, %error, "ticket refused");
            close(ByeReason::Ticket, Some(ErrorCode::BadTicket));
            let _ = writer.await;
            return;
        }
    };

    // Whether the journal holds the client's last op (an actor that never saw this client trusts only that).
    let journal_last = match hello.last_seq {
        0 => None,
        seq => app
            .shared
            .journal
            .find_client_op(&file, &hello.client_id, seq)
            .await
            .ok()
            .flatten()
            .map(|version| (seq, version)),
    };
    // Over the memory cap the node opens no new file: the lease api took for this node goes back, so the client's
    // reconnect asks /session again and lands on another node (crate::memory).
    if app.docs.get(&file).is_none() && crate::memory::full(config.memory_limit) {
        metrics().joins_refused_memory_total.inc();
        if let Ok(fence) = app.shared.lease.acquire(&file, &config.node).await {
            app.shared.lease.release(&file, &config.node, fence).await;
        }
        close(ByeReason::Limit, None);
        let _ = writer.await;
        return;
    }
    let mut attempts = 0;
    let (
        actor,
        Joined {
            conn,
            presence: presence_inbox,
        },
    ) = loop {
        attempts += 1;
        if attempts > 3 {
            close(ByeReason::Shutdown, None);
            let _ = writer.await;
            return;
        }
        // A draining node takes no new file, also on a retry after its old actor stopped (crate::drain).
        if crate::drain::refuse_new_file(&app, &file).await {
            close(ByeReason::Shutdown, None);
            let _ = writer.await;
            return;
        }
        let actor = app.docs.get_or_spawn(&file, &app.shared);
        let (reply, answer) = oneshot::channel();
        let join = JoinRequest {
            user: claims.user.clone(),
            name: claims.name.clone(),
            role: claims.role,
            client: hello.client_id.clone(),
            outbox: Arc::clone(&outbox),
            wire,
            fields: hello.fields(),
            since: hello.since,
            last_seq: hello.last_seq,
            journal_last,
            reply,
        };
        if actor.send(ActorMsg::Join(Box::new(join))).await.is_err() {
            continue;
        }
        match answer.await {
            Ok(Ok(conn)) => break (actor, conn),
            Ok(Err(reason)) => {
                close(reason, None);
                let _ = writer.await;
                return;
            }
            Err(_) => continue,
        }
    };

    let mut ops = Bucket::new(config.ops_per_second);
    let mut bytes_in = Bucket::new(config.bytes_per_second);
    let mut presence = Bucket::new(config.presence_per_second);
    let mut bad = 0;
    let refuse = |seq: Seq, code: ErrorCode, message: &str| {
        metrics().ops_refused_total.inc();
        outbox.push(codec.encode_server(&ServerMsg::Refused {
            seq,
            code,
            current_version: None,
            path: None,
            node_id: None,
            message: Some(message.to_owned()),
        }));
    };
    // One timer for liveness, re-armed only when it fires (not once per message). A socket quiet for `ping` gets
    // a WebSocket ping, which the browser answers itself (a background tab's timers may run once a minute, so
    // its own `ping` can come too late); any frame, a pong included, counts as heard. Quiet for `silence`: closed.
    let ping_after = config.ping.min(config.silence);
    let liveness = tokio::time::sleep(ping_after);
    tokio::pin!(liveness);
    let mut heard = tokio::time::Instant::now();
    let mut pinged = false;
    loop {
        let incoming = tokio::select! {
            incoming = reader.next() => incoming,
            _ = &mut liveness => {
                let quiet = heard.elapsed();
                if quiet >= config.silence {
                    outbox.close(ByeReason::Silent);
                    break;
                }
                if !pinged && quiet >= ping_after {
                    pinged = true;
                    metrics().pings_sent_total.inc();
                    outbox.push(Out::ping());
                }
                let next = if pinged { config.silence } else { ping_after };
                liveness.as_mut().reset(heard + next);
                continue;
            }
        };
        pinged = false;
        let received = Instant::now();
        heard = tokio::time::Instant::from_std(received);
        let bytes = match incoming {
            Ok(Some(Incoming::Text(bytes) | Incoming::Binary(bytes))) => bytes,
            Ok(Some(Incoming::Ping(payload))) => {
                outbox.push(Out::pong(payload));
                continue;
            }
            Ok(Some(Incoming::Pong)) => continue,
            Ok(Some(Incoming::Close) | None) | Err(_) => break,
        };
        let bytes: &[u8] = &bytes;
        metrics().bytes_in_total.add(bytes.len() as u64);
        if bytes.len() > limits::MAX_MESSAGE_BYTES {
            refuse(
                seq_of(bytes).unwrap_or(0),
                ErrorCode::DesignDocumentTooLarge,
                "The change is larger than 8 MB.",
            );
            continue;
        }
        let over_bytes = !bytes_in.take(bytes.len() as f64);
        let decoded = codec.decode_client(bytes);
        let forward = match decoded {
            Ok(ClientMsg::Op(op)) => {
                metrics().op_decode.record(received.elapsed());
                if over_bytes || !ops.take(1.0) {
                    refuse(
                        op.seq,
                        ErrorCode::DesignLiveBusy,
                        "Too many changes. Try again later.",
                    );
                    continue;
                }
                ActorMsg::Op { conn, op, received }
            }
            Ok(ClientMsg::Presence(update)) => {
                if over_bytes || !presence.take(1.0) {
                    metrics().presence_dropped_total.inc();
                    continue;
                }
                if !presence_inbox.push(conn, update) {
                    continue;
                }
                ActorMsg::PresenceDue
            }
            Ok(ClientMsg::Pull { since }) => ActorMsg::Pull { conn, since },
            Ok(ClientMsg::Ping) => {
                outbox.push(codec.encode_server(&ServerMsg::Pong));
                continue;
            }
            Ok(ClientMsg::Hello(_)) => {
                close(ByeReason::Protocol, Some(ErrorCode::BadMessage));
                break;
            }
            Err(error) => {
                match error.seq {
                    Some(seq) => {
                        metrics().ops_refused_total.inc();
                        outbox.push(
                            codec.encode_server(&ServerMsg::Refused {
                                seq,
                                code: error.code,
                                current_version: None,
                                node_id: error
                                    .path
                                    .as_deref()
                                    .and_then(|p| p.strip_prefix("patch.nodes."))
                                    .map(|p| p.split('.').next().unwrap_or(p).to_owned()),
                                path: error.path,
                                message: Some(error.message),
                            }),
                        );
                    }
                    None => {
                        bad += 1;
                        outbox.push(codec.encode_server(&ServerMsg::Error {
                            code: error.code,
                            message: Some(error.message),
                        }));
                        if bad >= 3 {
                            outbox.close(ByeReason::Protocol);
                            break;
                        }
                    }
                }
                continue;
            }
        };
        if actor.send(forward).await.is_err() {
            // The actor stopped (a drain, a move): the acks it queued still go out before the bye.
            outbox.close_after_queued(ByeReason::Shutdown);
            break;
        }
        if outbox.is_closing() {
            break;
        }
    }
    let _ = actor.send(ActorMsg::Leave { conn }).await;
    // A close already under way (a drain's `bye` after the queued acks) keeps its frames.
    if !outbox.is_closing() {
        outbox.close(ByeReason::Session);
    }
    let _ = writer.await;
}
