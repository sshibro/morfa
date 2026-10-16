//! AWS Signature Version 4 for S3 (header authorization and presigned URLs), as every S3-compatible provider
//! accepts it. Tested against the examples of the AWS S3 API reference ("Signature Calculations for the
//! Authorization Header", "Authenticating Requests: Using Query Parameters").

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// The hex sha256 of the empty payload.
pub const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone)]
pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}

/// `YYYYMMDDTHHMMSSZ` of a time.
pub fn amz_date(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// RFC 3986 encoding as SigV4 wants it: unreserved characters stay, `/` stays when `keep_slash`.
pub fn uri_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (uri_encode(key, false), uri_encode(value, false)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// One request to sign: `path` is already URI-encoded (`/bucket/key`), `query` raw.
pub struct Request<'a> {
    pub method: &'a str,
    pub host: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    /// Headers besides `host`, `x-amz-date` and `x-amz-content-sha256` that are sent and signed.
    pub headers: &'a [(&'a str, &'a str)],
}

impl Credentials {
    fn scope(&self, date: &str) -> String {
        format!("{}/{}/s3/aws4_request", &date[..8], self.region)
    }

    fn signature(&self, date: &str, canonical_request: &str) -> String {
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{date}\n{}\n{}",
            self.scope(date),
            sha256_hex(canonical_request.as_bytes())
        );
        let key = [&date[..8], &self.region, "s3", "aws4_request"]
            .iter()
            .fold(
                format!("AWS4{}", self.secret_key).into_bytes(),
                |key, part| hmac(&key, part.as_bytes()),
            );
        hex(&hmac(&key, to_sign.as_bytes()))
    }

    /// The headers that authorize `request` with a payload whose hex sha256 is `payload_sha256` (or
    /// `UNSIGNED-PAYLOAD`): `authorization`, `x-amz-date`, `x-amz-content-sha256`.
    pub fn sign(
        &self,
        request: &Request,
        payload_sha256: &str,
        time: SystemTime,
    ) -> Vec<(String, String)> {
        let date = amz_date(time);
        let mut headers: Vec<(String, String)> = vec![
            ("host".into(), request.host.into()),
            ("x-amz-content-sha256".into(), payload_sha256.into()),
            ("x-amz-date".into(), date.clone()),
        ];
        headers.extend(
            request
                .headers
                .iter()
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned())),
        );
        headers.sort();
        let signed: Vec<&str> = headers.iter().map(|(name, _)| name.as_str()).collect();
        let signed = signed.join(";");
        let canonical = format!(
            "{}\n{}\n{}\n{}\n{signed}\n{payload_sha256}",
            request.method,
            request.path,
            canonical_query(request.query),
            headers
                .iter()
                .map(|(name, value)| format!("{name}:{value}\n"))
                .collect::<String>(),
        );
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{},SignedHeaders={signed},Signature={}",
            self.access_key,
            self.scope(&date),
            self.signature(&date, &canonical)
        );
        vec![
            ("authorization".into(), authorization),
            ("x-amz-content-sha256".into(), payload_sha256.into()),
            ("x-amz-date".into(), date),
        ]
    }

    /// The query string of a presigned GET of `path` on `host`, valid `expires` seconds from `time`.
    pub fn presign(&self, host: &str, path: &str, expires: u64, time: SystemTime) -> String {
        let date = amz_date(time);
        let mut query = vec![
            ("X-Amz-Algorithm".to_owned(), "AWS4-HMAC-SHA256".to_owned()),
            (
                "X-Amz-Credential".to_owned(),
                format!("{}/{}", self.access_key, self.scope(&date)),
            ),
            ("X-Amz-Date".to_owned(), date.clone()),
            ("X-Amz-Expires".to_owned(), expires.to_string()),
            ("X-Amz-SignedHeaders".to_owned(), "host".to_owned()),
        ];
        let canonical = format!(
            "GET\n{path}\n{}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD",
            canonical_query(&query)
        );
        query.push((
            "X-Amz-Signature".to_owned(),
            self.signature(&date, &canonical),
        ));
        canonical_query(&query)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn example() -> (Credentials, SystemTime) {
        (
            Credentials {
                access_key: "AKIAIOSFODNN7EXAMPLE".into(),
                secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
                region: "us-east-1".into(),
            },
            // 2013-05-24T00:00:00Z
            UNIX_EPOCH + Duration::from_secs(1_369_353_600),
        )
    }

    #[test]
    fn dates() {
        assert_eq!(amz_date(example().1), "20130524T000000Z");
        assert_eq!(
            amz_date(UNIX_EPOCH + Duration::from_secs(951_782_400 + 3_661)),
            "20000229T010101Z"
        );
    }

    #[test]
    fn get_object_header_example() {
        let (credentials, time) = example();
        let headers = credentials.sign(
            &Request {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                path: "/test.txt",
                query: &[],
                headers: &[("Range", "bytes=0-9")],
            },
            EMPTY_SHA256,
            time,
        );
        assert_eq!(
            headers[0].1,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,\
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,\
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn presigned_get_example() {
        let (credentials, time) = example();
        let query =
            credentials.presign("examplebucket.s3.amazonaws.com", "/test.txt", 86_400, time);
        assert!(
            query.contains(
                "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
            ),
            "{query}"
        );
    }

    #[test]
    fn encoding() {
        assert_eq!(uri_encode("img/a b+c~", true), "img/a%20b%2Bc~");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
    }
}
