//! A minimal HTTP/1.1 GET and POST over plain TCP for calls to api on the private network (ACL re-validation, the
//! checkpoint notice). One request per connection (`Connection: close`); TLS is Caddy's job at the edge, never on this
//! hop.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// GETs `url` (`http://host[:port]/path?query`) with a bearer token; Ok(body) on a 2xx answer.
pub async fn get(url: &str, bearer: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    request("GET", url, bearer, None, timeout).await
}

/// POSTs a JSON `body` to `url` with a bearer token; Ok(body) on a 2xx answer.
pub async fn post(
    url: &str,
    bearer: &str,
    body: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    request("POST", url, bearer, Some(body), timeout).await
}

async fn request(
    method: &str,
    url: &str,
    bearer: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// is supported: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let address = if authority.contains(':') {
        authority.to_owned()
    } else {
        format!("{authority}:80")
    };
    let work = async {
        let mut stream = TcpStream::connect(&address)
            .await
            .map_err(|e| format!("connect {address}: {e}"))?;
        let request = match body {
            Some(body) => format!(
                "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {bearer}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
            None => format!(
                "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {bearer}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
            ),
        };
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut response = Vec::with_capacity(1024);
        stream
            .take(1024 * 1024)
            .read_to_end(&mut response)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(response)
    };
    let response = tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| format!("timeout after {timeout:?}"))??;
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no header end")?;
    let head = std::str::from_utf8(&response[..split]).map_err(|e| e.to_string())?;
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status")?;
    let mut body = response[split + 4..].to_vec();
    if head.lines().any(|l| {
        l.to_ascii_lowercase().starts_with("transfer-encoding:")
            && l.to_ascii_lowercase().contains("chunked")
    }) {
        body = dechunk(&body).ok_or("bad chunked body")?;
    }
    if !(200..300).contains(&status) {
        return Err(format!("status {status}"));
    }
    Ok(body)
}

fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&data[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(data.get(..size)?);
        data = data.get(size + 2..)?;
    }
}
