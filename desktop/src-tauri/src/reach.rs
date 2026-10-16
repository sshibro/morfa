//! Whether the app's server answers at all: before a window loads the app, so an unreachable server shows the
//! bundled offline page (desktop/offline/index.html) instead of the web view's own error.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use url::Url;

/// A TCP connection to the origin's host and port within `timeout` (DNS included). TLS and HTTP are the web
/// view's business: a server that accepts connections but fails requests shows the app's own error pages.
pub fn reachable(origin: &Url, timeout: Duration) -> bool {
    let Some(host) = origin.host_str() else {
        return false;
    };
    let Some(port) = origin.port_or_known_default() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let started = Instant::now();
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    for address in addresses {
        let left = timeout.saturating_sub(started.elapsed());
        if left.is_zero() {
            return false;
        }
        if TcpStream::connect_timeout(&address, left).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sees_a_listening_server_and_a_closed_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let open = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        assert!(reachable(&open, Duration::from_secs(2)));
        drop(listener);
        assert!(
            !reachable(&open, Duration::from_secs(2)),
            "nothing listens there now"
        );
        assert!(!reachable(
            &Url::parse("https://does-not-exist.invalid").unwrap(),
            Duration::from_secs(2)
        ));
    }
}
