//! A Rust client of the socket, for the convergence tests, the benchmarks and B0's loadgen: a connection
//! ([`Client`]) and the document as a client confirms it ([`Replica`]: the server's changes and its own acked
//! ops applied in version order).

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use morfa_model::{DesignDocument, DocumentPatch};
use morfa_protocol::codec::FrameKind;
use morfa_protocol::{
    Change, ChangeFields, ClientMsg, Codec, Frame, Seq, ServerMsg, Version, Wire,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct Sender {
    sink: SplitSink<Stream, Message>,
    codec: &'static dyn Codec,
}

pub struct Receiver {
    stream: SplitStream<Stream>,
    codec: &'static dyn Codec,
}

fn message(frame: Frame) -> Message {
    match frame.kind {
        FrameKind::Text => Message::Text(
            tokio_tungstenite::tungstenite::Utf8Bytes::try_from(frame.bytes)
                .expect("codecs write UTF-8 text"),
        ),
        FrameKind::Binary => Message::Binary(frame.bytes),
    }
}

impl Sender {
    pub async fn send(&mut self, msg: &ClientMsg) -> Result<(), String> {
        self.sink
            .send(message(self.codec.encode_client(msg)))
            .await
            .map_err(|e| e.to_string())
    }

    /// A frame as it is (malformed-frame tests).
    pub async fn send_text(&mut self, text: &str) -> Result<(), String> {
        self.sink
            .send(Message::Text(text.into()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn close(&mut self) {
        let _ = self.sink.close().await;
    }
}

impl Receiver {
    /// The next server message; None when the socket closed.
    pub async fn recv(&mut self) -> Option<ServerMsg> {
        self.recv_raw().await.map(|(msg, _)| msg)
    }

    /// The next frame's bytes, undecoded (load drivers that only peek at frames).
    pub async fn recv_bytes(&mut self) -> Option<bytes::Bytes> {
        loop {
            match self.stream.next().await?.ok()? {
                Message::Text(text) => return Some(text.into()),
                Message::Binary(bytes) => return Some(bytes),
                Message::Close(_) => return None,
                _ => continue,
            }
        }
    }

    /// The next message and its frame's size.
    pub async fn recv_raw(&mut self) -> Option<(ServerMsg, usize)> {
        loop {
            let message = self.stream.next().await?.ok()?;
            let bytes = match &message {
                Message::Text(text) => text.as_bytes(),
                Message::Binary(bytes) => bytes,
                Message::Close(_) => return None,
                _ => continue,
            };
            let msg = self
                .codec
                .decode_server(bytes)
                .unwrap_or_else(|e| panic!("server sent an unreadable frame: {e}"));
            return Some((msg, bytes.len()));
        }
    }
}

/// Connects to `ws://host/collab/<file>?wire=json`.
pub async fn connect(url: &str, wire: Wire) -> Result<(Sender, Receiver), String> {
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(64 << 20);
    config.max_frame_size = Some(64 << 20);
    let (stream, _) = connect_async_with_config(url, Some(config), true)
        .await
        .map_err(|e| e.to_string())?;
    let (sink, stream) = stream.split();
    let codec = wire.codec();
    Ok((Sender { sink, codec }, Receiver { stream, codec }))
}

/// The document as one client has it confirmed by the server.
#[derive(Debug, Clone)]
pub struct Replica {
    pub doc: DesignDocument,
    pub version: Version,
    /// Changes and acked own ops waiting for an earlier version (with a change's field-level nodes, protocol 2).
    pending: BTreeMap<Version, (Arc<DocumentPatch>, Option<Arc<ChangeFields>>)>,
    /// Own ops sent and not yet acked, by seq (a field op's layers as its fields: spread when it lands, protocol 2).
    sent: HashMap<Seq, (DocumentPatch, Option<Arc<ChangeFields>>)>,
}

impl Replica {
    pub fn new(doc: DesignDocument, version: Version) -> Self {
        Replica {
            doc,
            version,
            pending: BTreeMap::new(),
            sent: HashMap::new(),
        }
    }

    pub fn sent(&mut self, seq: Seq, patch: DocumentPatch) {
        self.sent.insert(seq, (patch, None));
    }

    /// A field op sent: when it lands as sent, its fields are spread over this replica's layers at that version.
    pub fn sent_fields(&mut self, seq: Seq, patch: DocumentPatch, fields: ChangeFields) {
        self.sent.insert(seq, (patch, Some(Arc::new(fields))));
    }

    pub fn unacked(&self) -> usize {
        self.sent.len()
    }

    /// Forgets an op the server refused.
    pub fn refused(&mut self, seq: Seq) -> Option<DocumentPatch> {
        self.sent.remove(&seq).map(|(patch, _)| patch)
    }

    /// Feeds one server message; true when it changed the replica.
    pub fn on_message(&mut self, msg: &ServerMsg) -> bool {
        match msg {
            ServerMsg::Change(change) => self.insert_change(change),
            ServerMsg::Changes { changes } => {
                let mut any = false;
                for change in changes {
                    any |= self.insert_change(change);
                }
                any
            }
            ServerMsg::Ack { seq, version, own } => {
                let (patch, fields) = match (own, self.sent.remove(seq)) {
                    (Some(own), _) => (Arc::clone(own), None),
                    (None, Some((sent, fields))) => (Arc::new(sent), fields),
                    // A re-ack of an op this replica already holds.
                    (None, None) => return false,
                };
                // An op the merge left nothing of is acked on the version it found, which is another client's
                // change: when that change already waits here (it came first on this socket), it stays.
                if self.pending.contains_key(version) {
                    return false;
                }
                self.insert_with(*version, patch, fields)
            }
            ServerMsg::Document { version, document } => {
                self.doc = (**document).clone();
                self.version = *version;
                self.pending.retain(|v, _| *v > *version);
                self.apply_ready();
                true
            }
            _ => false,
        }
    }

    fn insert_change(&mut self, change: &Change) -> bool {
        self.insert_with(
            change.version,
            Arc::clone(&change.patch),
            change.fields.clone(),
        )
    }

    fn insert_with(
        &mut self,
        version: Version,
        patch: Arc<DocumentPatch>,
        fields: Option<Arc<ChangeFields>>,
    ) -> bool {
        if version <= self.version {
            return false;
        }
        self.pending.insert(version, (patch, fields));
        self.apply_ready();
        true
    }

    fn apply_ready(&mut self) {
        while let Some((patch, fields)) = self.pending.remove(&(self.version + 1)) {
            match fields {
                // Protocol 2: the fields spread over the node this replica holds at the previous version.
                Some(fields) => {
                    let doc = &self.doc;
                    morfa_protocol::fields::resolve(&patch, Some(&fields), |id| {
                        doc.nodes.get(id).cloned()
                    })
                    .unwrap_or_else(|e| panic!("v{}: {e}", self.version + 1))
                    .apply(&mut self.doc)
                }
                None => patch.apply(&mut self.doc),
            }
            self.version += 1;
        }
    }

    /// Versions waiting for a gap to close.
    pub fn gaps(&self) -> usize {
        self.pending.len()
    }
}
