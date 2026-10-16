//! The collab socket's WebSocket (RFC 6455), framed here on the upgraded TCP stream rather than through
//! tungstenite. What that buys (TARGETS M10, M5: a cursor update is a few hundred bytes, 30 a second per user):
//! - reads land in spare buffer capacity, never in a zero-filled chunk, and are unmasked in place;
//! - a frame goes out as `writev(header, payload)`: the payload's bytes are the ones the actor encoded once for
//!   every receiver, never copied into a per-socket buffer;
//! - the write half is shared with the connection's [`Outbox`](crate::backpressure::Outbox), so the actor can write a
//!   frame straight into an idle socket instead of waking the connection's writer task.
//!
//! The server side only: client frames must be masked, server frames are not; no extensions, no subprotocols.

use axum::http::{HeaderMap, HeaderValue, Method, header};
use bytes::{Buf, Bytes, BytesMut};
use std::io::{self, IoSlice};
use tokio::io::AsyncReadExt;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};

pub const OP_CONTINUATION: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

/// Close codes the reader answers with.
pub const CLOSE_PROTOCOL: u16 = 1002;
pub const CLOSE_INVALID_DATA: u16 = 1007;
pub const CLOSE_TOO_BIG: u16 = 1009;

/// The first read's room; a larger frame grows the buffer to its size once its header is read.
const READ_CHUNK: usize = 4 << 10;

/// `Sec-WebSocket-Accept` for a valid upgrade request (RFC 6455 §4.2.1); None: not a WebSocket upgrade.
pub fn accept_key(method: &Method, headers: &HeaderMap) -> Option<HeaderValue> {
    let has_token = |name: header::HeaderName, token: &str| {
        headers.get_all(name).iter().any(|value| {
            value
                .to_str()
                .is_ok_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
        })
    };
    if method != Method::GET
        || !has_token(header::CONNECTION, "upgrade")
        || !has_token(header::UPGRADE, "websocket")
        || headers.get(header::SEC_WEBSOCKET_VERSION)?.as_bytes() != b"13"
    {
        return None;
    }
    let key = headers.get(header::SEC_WEBSOCKET_KEY)?;
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    HeaderValue::from_str(&accept).ok()
}

/// A frame header for a server frame (FIN set, unmasked).
pub fn header(opcode: u8, len: usize) -> ([u8; 10], usize) {
    let mut out = [0u8; 10];
    out[0] = 0x80 | opcode;
    let n = if len < 126 {
        out[1] = len as u8;
        2
    } else if len <= u16::MAX as usize {
        out[1] = 126;
        out[2..4].copy_from_slice(&(len as u16).to_be_bytes());
        4
    } else {
        out[1] = 127;
        out[2..10].copy_from_slice(&(len as u64).to_be_bytes());
        10
    };
    (out, n)
}

/// What a client sent.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Text(Bytes),
    Binary(Bytes),
    Ping(Bytes),
    Pong,
    Close,
}

#[derive(Debug)]
pub enum ReadError {
    Io(io::Error),
    /// A protocol violation: close with this code.
    Protocol(u16, &'static str),
}

impl From<io::Error> for ReadError {
    fn from(error: io::Error) -> Self {
        ReadError::Io(error)
    }
}

/// XORs `data` with the 4-byte `key` (the mask starts at `data[0]`).
fn unmask(data: &mut [u8], key: [u8; 4]) {
    let wide = u64::from_ne_bytes([
        key[0], key[1], key[2], key[3], key[0], key[1], key[2], key[3],
    ]);
    let (chunks, rest) = data.as_chunks_mut::<8>();
    for chunk in chunks {
        *chunk = (u64::from_ne_bytes(*chunk) ^ wide).to_ne_bytes();
    }
    // The chunks cover a multiple of 8 bytes, so the key's phase is 0 again here.
    for (i, byte) in rest.iter_mut().enumerate() {
        *byte ^= key[i & 3];
    }
}

/// The read half: frames to messages (fragments joined, control frames passed through).
pub struct Reader {
    half: OwnedReadHalf,
    buf: BytesMut,
    max_message: usize,
    /// A fragmented message being joined: its opcode and the bytes so far.
    partial: Option<(u8, BytesMut)>,
}

/// One parsed frame.
struct RawFrame {
    fin: bool,
    opcode: u8,
    payload: BytesMut,
}

impl Reader {
    /// `initial`: bytes the HTTP layer read past the upgrade request.
    pub fn new(half: OwnedReadHalf, initial: Bytes, max_message: usize) -> Self {
        let mut buf = BytesMut::with_capacity(READ_CHUNK.max(initial.len()));
        buf.extend_from_slice(&initial);
        Reader {
            half,
            buf,
            max_message,
            partial: None,
        }
    }

    /// The next message; None at the end of the stream.
    pub async fn next(&mut self) -> Result<Option<Incoming>, ReadError> {
        loop {
            let frame = loop {
                match self.parse()? {
                    Some(frame) => break frame,
                    None => {
                        if self.buf.capacity() - self.buf.len() < 512 {
                            self.buf.reserve(READ_CHUNK);
                        }
                        if self.half.read_buf(&mut self.buf).await? == 0 {
                            return Ok(None);
                        }
                    }
                }
            };
            match frame.opcode {
                OP_PING => return Ok(Some(Incoming::Ping(frame.payload.freeze()))),
                OP_PONG => return Ok(Some(Incoming::Pong)),
                OP_CLOSE => return Ok(Some(Incoming::Close)),
                OP_TEXT | OP_BINARY if self.partial.is_some() => {
                    return Err(ReadError::Protocol(
                        CLOSE_PROTOCOL,
                        "a new message inside a fragmented one",
                    ));
                }
                OP_TEXT | OP_BINARY if frame.fin => {
                    return finish(frame.opcode, frame.payload).map(Some);
                }
                OP_TEXT | OP_BINARY => self.partial = Some((frame.opcode, frame.payload)),
                OP_CONTINUATION => {
                    let Some((opcode, mut joined)) = self.partial.take() else {
                        return Err(ReadError::Protocol(
                            CLOSE_PROTOCOL,
                            "a continuation without a message",
                        ));
                    };
                    if joined.len() + frame.payload.len() > self.max_message {
                        return Err(ReadError::Protocol(CLOSE_TOO_BIG, "message too large"));
                    }
                    joined.unsplit(frame.payload);
                    if frame.fin {
                        return finish(opcode, joined).map(Some);
                    }
                    self.partial = Some((opcode, joined));
                }
                _ => return Err(ReadError::Protocol(CLOSE_PROTOCOL, "unknown opcode")),
            }
        }
    }

    /// A whole frame from the buffer, or None when more bytes are needed (the buffer then has room for them).
    fn parse(&mut self) -> Result<Option<RawFrame>, ReadError> {
        let buf = &self.buf[..];
        if buf.len() < 2 {
            return Ok(None);
        }
        let (b0, b1) = (buf[0], buf[1]);
        let fin = b0 & 0x80 != 0;
        let opcode = b0 & 0x0F;
        if b0 & 0x70 != 0 {
            return Err(ReadError::Protocol(CLOSE_PROTOCOL, "reserved bits set"));
        }
        if b1 & 0x80 == 0 {
            return Err(ReadError::Protocol(CLOSE_PROTOCOL, "unmasked client frame"));
        }
        let (len, at) = match b1 & 0x7F {
            126 => {
                if buf.len() < 4 {
                    return Ok(None);
                }
                (u16::from_be_bytes([buf[2], buf[3]]) as u64, 4)
            }
            127 => {
                if buf.len() < 10 {
                    return Ok(None);
                }
                (
                    u64::from_be_bytes(buf[2..10].try_into().expect("8 bytes")),
                    10,
                )
            }
            n => (n as u64, 2),
        };
        if opcode >= OP_CLOSE && (!fin || len > 125) {
            return Err(ReadError::Protocol(
                CLOSE_PROTOCOL,
                "a fragmented or long control frame",
            ));
        }
        let joined = self.partial.as_ref().map_or(0, |(_, p)| p.len());
        if len > (self.max_message - joined.min(self.max_message)) as u64 {
            return Err(ReadError::Protocol(CLOSE_TOO_BIG, "message too large"));
        }
        let len = len as usize;
        let total = at + 4 + len;
        if self.buf.len() < total {
            self.buf.reserve(total - self.buf.len());
            return Ok(None);
        }
        let key: [u8; 4] = self.buf[at..at + 4].try_into().expect("4 bytes");
        let mut frame = self.buf.split_to(total);
        frame.advance(at + 4);
        unmask(&mut frame, key);
        Ok(Some(RawFrame {
            fin,
            opcode,
            payload: frame,
        }))
    }
}

fn finish(opcode: u8, payload: BytesMut) -> Result<Incoming, ReadError> {
    if opcode == OP_TEXT {
        if std::str::from_utf8(&payload).is_err() {
            return Err(ReadError::Protocol(CLOSE_INVALID_DATA, "text is not UTF-8"));
        }
        Ok(Incoming::Text(payload.freeze()))
    } else {
        Ok(Incoming::Binary(payload.freeze()))
    }
}

/// The write half, shared by the connection's writer task and (for frames to an idle socket) the actor.
pub struct Writer {
    half: OwnedWriteHalf,
}

/// How far a write got.
pub enum Wrote {
    All,
    /// This many bytes of the framed bytes went out; the socket is full.
    Part(usize),
}

impl Writer {
    pub fn new(half: OwnedWriteHalf) -> Self {
        Writer { half }
    }

    /// Writes one frame now if the socket takes it, never waiting.
    pub fn try_frame(&self, opcode: u8, payload: &[u8]) -> io::Result<Wrote> {
        let (head, n) = header(opcode, payload.len());
        let total = n + payload.len();
        let mut done = 0;
        while done < total {
            let result = if done < n {
                self.half
                    .try_write_vectored(&[IoSlice::new(&head[done..n]), IoSlice::new(payload)])
            } else {
                self.half.try_write(&payload[done - n..])
            };
            match result {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(k) => done += k,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(Wrote::Part(done)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(Wrote::All)
    }

    /// Writes all of `chunks` (already framed bytes), waiting while the socket is full.
    pub async fn write_all(&self, chunks: &mut Vec<Bytes>) -> io::Result<()> {
        const MAX_SLICES: usize = 64;
        // An empty payload (a ping or pong without data) is an empty chunk: a write of nothing would be read as
        // a dead socket (`Ok(0)`), so it goes before the loop.
        chunks.retain(|chunk| !chunk.is_empty());
        while !chunks.is_empty() {
            let slices: Vec<IoSlice<'_>> = chunks
                .iter()
                .take(MAX_SLICES)
                .map(|c| IoSlice::new(c))
                .collect();
            let wrote = match self.half.try_write_vectored(&slices) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(k) => k,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    drop(slices);
                    self.half.writable().await?;
                    continue;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            drop(slices);
            let mut left = wrote;
            while left > 0 {
                let first = &mut chunks[0];
                if first.len() <= left {
                    left -= first.len();
                    chunks.remove(0);
                } else {
                    first.advance(left);
                    left = 0;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmask_matches_the_bytewise_rule() {
        let key = [0x12, 0x34, 0x56, 0x78];
        for len in [0, 1, 3, 7, 8, 9, 15, 16, 17, 100] {
            let data: Vec<u8> = (0..len).map(|i| (i * 7) as u8).collect();
            let mut fast = data.clone();
            unmask(&mut fast, key);
            let slow: Vec<u8> = data
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ key[i % 4])
                .collect();
            assert_eq!(fast, slow, "len {len}");
        }
    }

    #[test]
    fn headers_by_length() {
        assert_eq!(&header(OP_TEXT, 5).0[..2], &[0x81, 5]);
        let (h, n) = header(OP_BINARY, 300);
        assert_eq!((n, &h[..4]), (4, &[0x82, 126, 1, 44][..]));
        let (h, n) = header(OP_TEXT, 70_000);
        assert_eq!(n, 10);
        assert_eq!(h[1], 127);
        assert_eq!(u64::from_be_bytes(h[2..10].try_into().unwrap()), 70_000);
    }
}
