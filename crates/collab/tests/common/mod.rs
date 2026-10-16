//! The test harness: an in-process service on 127.0.0.1:0 with the in-memory journal and lease, tickets signed
//! by a test key, documents of N rectangles, and an editor that edits through the socket and keeps a replica.
#![allow(dead_code)]

use morfa_collab::actor::{ActorMsg, Inspect};
use morfa_collab::client::{self, Receiver, Replica, Sender};
use morfa_collab::journal::MemJournal;
use morfa_collab::lease::MemLease;
use morfa_collab::router::{EngineFactory, ops_engine};
use morfa_collab::{App, Config, Shared, Tickets};
use morfa_model::{DesignDocument, DocumentPatch, Map, SceneNode, from_json_validated, to_json};
use morfa_protocol::ticket::{Claims, TicketSigningKey, mint};
use morfa_protocol::{
    ClientId, ClientMsg, Hello, Op, PROTOCOL_VERSION, Role, Seq, ServerMsg, Version, Wire,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

pub const BLANK_PAGE: &str = r#"{"id":"page","type":"PAGE","name":"Page 1","parentId":null,"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":0,"height":0,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"children":[],"guides":[],"flowStartingPoints":[],"prototypeDevice":{"type":"NONE"},"backgroundColor":{"r":0.96,"g":0.96,"b":0.96}}"#;
pub const RECTANGLE: &str = r#"{"id":"ID","type":"RECTANGLE","name":"Rectangle","parentId":"page","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":100,"height":30,"rotation":0,"fills":[{"type":"SOLID","color":{"r":0.85,"g":0.85,"b":0.85},"opacity":1,"visible":true,"blendMode":"NORMAL"}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":0,"cornerSmoothing":0}"#;

/// A page of `n` rectangles `r0…`.
pub fn rect_doc(n: usize) -> DesignDocument {
    let ids: Vec<String> = (0..n).map(|i| format!("\"r{i}\"")).collect();
    let page = BLANK_PAGE.replace(
        "\"children\":[]",
        &format!("\"children\":[{}]", ids.join(",")),
    );
    let mut nodes = vec![format!("\"page\":{page}")];
    for i in 0..n {
        nodes.push(format!(
            "\"r{i}\":{}",
            RECTANGLE.replace("\"ID\"", &format!("\"r{i}\""))
        ));
    }
    let json = format!(
        r#"{{"schemaVersion":1,"pages":["page"],"nodes":{{{}}},"styles":{{}},"images":{{}},"variableCollections":{{}},"variables":{{}}}}"#,
        nodes.join(",")
    );
    from_json_validated(&json).unwrap_or_else(|e| panic!("{e}"))
}

/// A new rectangle node `id` under the page.
pub fn rect(id: &str) -> SceneNode {
    let mut doc = rect_doc(1);
    let mut node = doc.nodes.shift_remove("r0").unwrap();
    node.id = id.to_owned();
    node
}

pub struct Server {
    pub app: App,
    pub addr: std::net::SocketAddr,
    pub journal: Arc<MemJournal>,
    pub lease: Arc<MemLease>,
    pub key: TicketSigningKey,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct Options {
    pub config: Box<dyn FnOnce(&mut Config)>,
    pub engine: EngineFactory,
    pub acl: Option<Arc<dyn morfa_collab::acl::AclSource>>,
    /// Another journal and lease than the in-memory ones (`Server::journal` then goes unused).
    pub storage: Option<(
        Arc<dyn morfa_collab::journal::Journal>,
        Arc<dyn morfa_collab::lease::Lease>,
    )>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            config: Box::new(|_| {}),
            engine: ops_engine(),
            acl: None,
            storage: None,
        }
    }
}

impl Server {
    pub async fn start() -> Server {
        Self::start_with(Options::default()).await
    }

    pub async fn start_with(options: Options) -> Server {
        let key = TicketSigningKey::from_bytes(&[42; 32]);
        let mut config = Config::new(Tickets::Ed25519(key.verifying_key()));
        config.internal_secret = Some("secret".into());
        config.idle_close = Duration::from_secs(600);
        // Test editors never ping (a browser pings every PING_MS): an editor that finished its ops sits unread
        // while the others join and edit, and the server's SILENCE_MS close would end it mid-test once a loaded
        // run passes 50 s. Tests of the silence close set their own.
        config.silence = Duration::from_secs(600);
        // A loaded run must not move a room mid-test; the rebalance test calls App::rebalance_once itself.
        config.rebalance = false;
        (options.config)(&mut config);
        let journal = Arc::new(MemJournal::new());
        let lease = Arc::new(MemLease::new());
        let (shared_journal, shared_lease): (
            Arc<dyn morfa_collab::journal::Journal>,
            Arc<dyn morfa_collab::lease::Lease>,
        ) = match options.storage {
            Some(storage) => storage,
            None => (journal.clone(), lease.clone()),
        };
        let app = App::new(Shared {
            config,
            journal: shared_journal,
            lease: shared_lease,
            acl: options.acl,
            engine: options.engine,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = oneshot::channel::<()>();
        let served = app.clone();
        tokio::spawn(async move {
            morfa_collab::serve(listener, served, async {
                let _ = rx.await;
            })
            .await
            .unwrap();
        });
        Server {
            app,
            addr,
            journal,
            lease,
            key,
            shutdown: Some(tx),
        }
    }

    pub fn ticket(&self, file: &str, user: &str, role: Role) -> String {
        let exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 60;
        mint(
            &self.key,
            &Claims {
                file: file.into(),
                user: user.into(),
                name: format!("Member {user}"),
                role,
                team: None,
                origin: None,
                exp,
            },
        )
    }

    pub fn url(&self, file: &str) -> String {
        self.url_for(file, Wire::Json)
    }

    pub fn url_for(&self, file: &str, wire: Wire) -> String {
        format!("ws://{}/collab/{file}?wire={}", self.addr, wire.name())
    }

    pub async fn inspect(&self, file: &str) -> Inspect {
        let actor = self.app.docs.get(file).expect("file open");
        let (reply, answer) = oneshot::channel();
        actor.send(ActorMsg::Inspect { reply }).await.unwrap();
        answer.await.unwrap()
    }

    /// Waits until the journal holds everything the actor applied.
    pub async fn settled(&self, file: &str) -> Inspect {
        for _ in 0..500 {
            let inspect = self.inspect(file).await;
            if inspect.committed == inspect.version {
                return inspect;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("journal never caught up");
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// One editor: a socket, a replica, and its op counter.
pub struct Editor {
    pub tx: Sender,
    pub rx: Receiver,
    pub replica: Replica,
    pub client: ClientId,
    pub seq: Seq,
    pub connection: String,
    pub user: String,
    /// Every message received, in order (tests look back at it).
    pub log: Vec<ServerMsg>,
}

/// The longest a test editor waited for a server message (the convergence tests print it).
pub static MAX_WAIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How long a test waits for the server's next message. Under 4 burning cores and a parallel test binary the
/// longest wait of the 100-editor room is ≈ 2 s (MAX_WAIT_MS); a longer silence is a bug, not load.
pub const TIMEOUT: Duration = Duration::from_secs(20);

impl Editor {
    pub async fn join(server: &Server, file: &str, user: &str, role: Role) -> Editor {
        Self::join_as(
            server,
            file,
            user,
            role,
            ClientId::new(format!("tab-{user}-{}", rand::random::<u32>())),
            None,
            0,
            None,
        )
        .await
    }

    /// Joins over `wire`.
    pub async fn join_wire(
        server: &Server,
        file: &str,
        user: &str,
        role: Role,
        wire: Wire,
    ) -> Editor {
        Self::join_full(
            server,
            file,
            user,
            role,
            ClientId::new(format!("tab-{user}-{}", rand::random::<u32>())),
            None,
            0,
            None,
            wire,
        )
        .await
    }

    /// Joins; with `replica` and `since` it resumes (reconnect).
    #[allow(clippy::too_many_arguments)]
    pub async fn join_as(
        server: &Server,
        file: &str,
        user: &str,
        role: Role,
        client: ClientId,
        replica: Option<Replica>,
        seq: Seq,
        since: Option<Version>,
    ) -> Editor {
        Self::join_full(
            server,
            file,
            user,
            role,
            client,
            replica,
            seq,
            since,
            Wire::Json,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn join_full(
        server: &Server,
        file: &str,
        user: &str,
        role: Role,
        client: ClientId,
        replica: Option<Replica>,
        seq: Seq,
        since: Option<Version>,
        wire: Wire,
    ) -> Editor {
        Self::join_protocol(
            server,
            file,
            user,
            role,
            client,
            replica,
            seq,
            since,
            wire,
            PROTOCOL_VERSION,
        )
        .await
    }

    /// [`Editor::join_full`] speaking `protocol` (1: whole nodes in every change; 2: field-level changes).
    #[allow(clippy::too_many_arguments)]
    pub async fn join_protocol(
        server: &Server,
        file: &str,
        user: &str,
        role: Role,
        client: ClientId,
        replica: Option<Replica>,
        seq: Seq,
        since: Option<Version>,
        wire: Wire,
        protocol: u32,
    ) -> Editor {
        let (mut tx, mut rx) = client::connect(&server.url_for(file, wire), wire)
            .await
            .unwrap();
        tx.send(&ClientMsg::Hello(Hello {
            ticket: server.ticket(file, user, role),
            client_id: client.clone(),
            since,
            last_seq: seq,
            protocol,
        }))
        .await
        .unwrap();
        let welcome = match tokio::time::timeout(TIMEOUT, rx.recv()).await.unwrap() {
            Some(ServerMsg::Welcome(welcome)) => welcome,
            other => panic!("expected welcome, got {other:?}"),
        };
        let mut editor = Editor {
            tx,
            rx,
            replica: replica.unwrap_or_else(|| Replica::new(rect_doc(0), 0)),
            client,
            seq,
            connection: welcome.connection.clone(),
            user: user.into(),
            log: vec![ServerMsg::Welcome(welcome.clone())],
        };
        if welcome.resync {
            // The document frame follows.
            loop {
                let msg = editor.next().await.expect("document");
                if matches!(msg, ServerMsg::Document { .. }) {
                    break;
                }
            }
        }
        editor
    }

    /// The next message, fed to the replica.
    pub async fn next(&mut self) -> Option<ServerMsg> {
        let started = std::time::Instant::now();
        let got = tokio::time::timeout(TIMEOUT, self.rx.recv()).await;
        MAX_WAIT_MS.fetch_max(
            started.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        let msg = match got {
            Ok(msg) => msg?,
            Err(_) => {
                let tail: Vec<String> = self
                    .log
                    .iter()
                    .rev()
                    .take(6)
                    .map(|m| format!("{m:?}").chars().take(160).collect())
                    .collect();
                panic!(
                    "server silent: {} at v{} gaps {} unacked {} last {:#?}",
                    self.user,
                    self.replica.version,
                    self.replica.gaps(),
                    self.replica.unacked(),
                    tail
                );
            }
        };
        self.replica.on_message(&msg);
        self.log.push(msg.clone());
        Some(msg)
    }

    /// Sends an op made on the replica: `before` holds the replica's copies of the nodes it touches.
    pub async fn send_patch(&mut self, patch: DocumentPatch) -> Seq {
        self.seq += 1;
        let seq = self.seq;
        let before: Map<Option<SceneNode>> = patch
            .nodes
            .as_ref()
            .map(|nodes| {
                nodes
                    .keys()
                    .map(|k| (k.clone(), self.replica.doc.nodes.get(k).cloned()))
                    .collect()
            })
            .unwrap_or_default();
        let op = Op {
            seq,
            base_version: self.replica.version,
            patch: patch.clone(),
            before: Some(before.into()),
            before_tables: None,
            fields: None,
        };
        self.replica.sent(seq, patch);
        self.tx.send(&ClientMsg::Op(Box::new(op))).await.unwrap();
        seq
    }

    /// Sends a protocol 2 field op made on the replica (lane W): the replica keeps the whole nodes it stands for.
    pub async fn send_fields(&mut self, fields: morfa_protocol::OpFields) -> Seq {
        self.seq += 1;
        let seq = self.seq;
        let mut read = Map::default();
        for id in fields.ids() {
            read.insert(
                id.clone(),
                morfa_protocol::NodeFields {
                    set: fields.set.get(id).cloned().unwrap_or_default(),
                    unset: fields.unset.get(id).cloned().unwrap_or_default(),
                },
            );
        }
        self.replica.sent_fields(
            seq,
            DocumentPatch::default(),
            morfa_protocol::ChangeFields::Read(read),
        );
        let op = Op {
            seq,
            base_version: self.replica.version,
            patch: DocumentPatch::default(),
            before: None,
            before_tables: None,
            fields: Some(fields),
        };
        self.tx.send(&ClientMsg::Op(Box::new(op))).await.unwrap();
        seq
    }

    /// Reads until the answer to `seq` (ack or refused).
    pub async fn answer(&mut self, seq: Seq) -> ServerMsg {
        loop {
            let msg = self.next().await.expect("socket closed before the answer");
            match &msg {
                ServerMsg::Ack { seq: s, .. } if *s == seq => return msg,
                ServerMsg::Refused { seq: s, .. } if *s == seq => {
                    self.replica.refused(seq);
                    return msg;
                }
                _ => {}
            }
        }
    }

    /// Reads until the replica reaches `version`.
    pub async fn reach(&mut self, version: Version) {
        while self.replica.version < version {
            if self.next().await.is_none() {
                panic!("socket closed at {} before {version}", self.replica.version);
            }
        }
    }

    /// A move of `ids` by (dx, dy) on the replica's copies.
    pub fn move_patch(&self, ids: &[&str], dx: f64, dy: f64) -> DocumentPatch {
        let mut nodes = Map::default();
        for id in ids {
            let mut node = self.replica.doc.nodes[*id].clone();
            node.x += dx;
            node.y += dy;
            nodes.insert((*id).to_owned(), Some(node));
        }
        DocumentPatch {
            nodes: Some(nodes),
            ..Default::default()
        }
    }
}

pub fn same_doc(a: &DesignDocument, b: &DesignDocument) -> bool {
    to_json(a) == to_json(b)
}

/// A raw HTTP/1.1 request to the server (internal endpoints); answers `(status, body)`.
pub async fn http(
    server: &Server,
    method: &str,
    path: &str,
    body: &str,
    secret: Option<&str>,
) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    let auth = secret
        .map(|s| format!("Authorization: Bearer {s}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let text = String::from_utf8_lossy(&response).to_string();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}
