//! The WebSocket framing of crate::ws against raw bytes: the handshake, fragmented and masked client frames,
//! ping/pong, and the frames a server must refuse (unmasked, oversized, unknown opcodes).

mod common;

use common::*;
use morfa_protocol::{ClientId, ClientMsg, Hello, PROTOCOL_VERSION, Role, ServerMsg, Wire};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

/// Opens a raw socket and completes the handshake; answers the stream and the response head.
async fn open(server: &Server, file: &str) -> (TcpStream, String) {
    let mut tcp = TcpStream::connect(server.addr).await.unwrap();
    let request = format!(
        "GET /collab/{file}?wire=json HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8];
        tcp.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    (tcp, String::from_utf8(head).unwrap())
}

/// A masked client frame.
fn frame(fin: bool, opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![if fin { 0x80 } else { 0 } | opcode];
    match payload.len() {
        n if n < 126 => out.push(0x80 | n as u8),
        n if n <= u16::MAX as usize => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    let key = [0x37, 0xfa, 0x21, 0x3d];
    out.extend_from_slice(&key);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    out
}

/// The next server frame: (opcode, payload); None when the stream ended.
async fn read_frame(tcp: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    tokio::time::timeout(TIMEOUT, tcp.read_exact(&mut head))
        .await
        .expect("server silent")
        .ok()?;
    assert_eq!(head[0] & 0x80, 0x80, "server frames are whole");
    assert_eq!(head[1] & 0x80, 0, "server frames are unmasked");
    let len = match head[1] & 0x7f {
        126 => {
            let mut n = [0u8; 2];
            tcp.read_exact(&mut n).await.ok()?;
            u16::from_be_bytes(n) as usize
        }
        127 => {
            let mut n = [0u8; 8];
            tcp.read_exact(&mut n).await.ok()?;
            u64::from_be_bytes(n) as usize
        }
        n => n as usize,
    };
    let mut payload = vec![0u8; len];
    tcp.read_exact(&mut payload).await.ok()?;
    Some((head[0] & 0x0f, payload))
}

fn hello_json(server: &Server, file: &str) -> Vec<u8> {
    let codec = Wire::Json.codec();
    codec
        .encode_client(&ClientMsg::Hello(Hello {
            ticket: server.ticket(file, "a", Role::Editor),
            client_id: ClientId::new("raw-tab"),
            since: Some(0),
            last_seq: 0,
            protocol: PROTOCOL_VERSION,
        }))
        .bytes
        .to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_fragments_and_ping() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(1), 0);
    let (mut tcp, head) = open(&server, "f").await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    // RFC 6455 §1.3's example key and answer.
    assert!(
        head.to_ascii_lowercase()
            .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
        "{head}"
    );
    // `hello` in three fragments with a ping between them.
    let hello = hello_json(&server, "f");
    let (a, rest) = hello.split_at(10);
    let (b, c) = rest.split_at(20);
    let mut bytes = frame(false, 0x1, a);
    bytes.extend(frame(false, 0x0, b));
    bytes.extend(frame(true, 0x9, b"are you there"));
    bytes.extend(frame(true, 0x0, c));
    tcp.write_all(&bytes).await.unwrap();
    let mut pong = false;
    let mut welcome = false;
    while !(pong && welcome) {
        let (opcode, payload) = read_frame(&mut tcp).await.expect("open");
        match opcode {
            0xA => {
                assert_eq!(payload, b"are you there");
                pong = true;
            }
            0x1 => {
                let msg = Wire::Json.codec().decode_server(&payload).unwrap();
                if matches!(msg, ServerMsg::Welcome(_)) {
                    welcome = true;
                }
            }
            other => panic!("opcode {other}"),
        }
    }
    // A large message in one frame (64-bit length) reaches the decoder: a ping by a long route.
    let mut ping = br#"{"t":"ping"}"#.to_vec();
    ping.extend(std::iter::repeat_n(b' ', 70_000));
    tcp.write_all(&frame(true, 0x1, &ping)).await.unwrap();
    loop {
        let (opcode, payload) = read_frame(&mut tcp).await.expect("open");
        if opcode == 0x1
            && matches!(
                Wire::Json.codec().decode_server(&payload),
                Ok(ServerMsg::Pong)
            )
        {
            break;
        }
    }
    // A close is answered with `bye` and a close frame, then the stream ends.
    tcp.write_all(&frame(true, 0x8, &1000u16.to_be_bytes()))
        .await
        .unwrap();
    let mut closed = false;
    while let Some((opcode, _)) = read_frame(&mut tcp).await {
        closed |= opcode == 0x8;
    }
    assert!(closed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_frames_end_the_connection() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(1), 0);
    let bad: [Vec<u8>; 4] = [
        // Unmasked.
        vec![0x81, 0x02, b'{', b'}'],
        // A reserved bit.
        frame(true, 0x41, b"{}"),
        // An unknown opcode.
        frame(true, 0x3, b"{}"),
        // Longer than any message may be (the length alone is refused).
        {
            let mut f = vec![0x81, 0x80 | 127];
            f.extend_from_slice(&(1u64 << 40).to_be_bytes());
            f.extend_from_slice(&[0, 0, 0, 0]);
            f
        },
    ];
    for bytes in bad {
        let (mut tcp, head) = open(&server, "f").await;
        assert!(head.starts_with("HTTP/1.1 101"));
        tcp.write_all(&frame(true, 0x1, &hello_json(&server, "f")))
            .await
            .unwrap();
        tcp.write_all(&bytes).await.unwrap();
        // Whatever was sent before, the stream ends.
        let ended = tokio::time::timeout(Duration::from_secs(10), async {
            while read_frame(&mut tcp).await.is_some() {}
        })
        .await;
        assert!(ended.is_ok(), "{bytes:?} left the connection open");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_get_is_not_upgraded() {
    let server = Server::start().await;
    let (status, _) = http(&server, "GET", "/collab/f?wire=json", "", None).await;
    assert_eq!(status, 400);
}
