//! [`S3`]: an S3-compatible object store over HTTP (reqwest), signed with SigV4.
//!
//! Path-style addressing (`https://host/bucket/key`) by default: the Russian providers (Timeweb Cloud, Selectel,
//! Yandex Object Storage) all take it, and it needs no wildcard DNS or certificate. Objects above `part_size` go up
//! as a multipart upload, `concurrency` parts at a time; a failed multipart upload is aborted. Every request is
//! retried on network errors, 5xx and 429, `attempts` times in all, with backoff.

use crate::sigv4::{self, Credentials, EMPTY_SHA256, Request};
use crate::{Bytes, ObjectStore, StoreError};
use reqwest::{Method, StatusCode, Url};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;

#[derive(Debug, Clone)]
pub struct S3Config {
    /// `https://s3.timeweb.cloud`, `http://127.0.0.1:9451` (MinIO)...
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    /// `https://endpoint/bucket/key` (true) or `https://bucket.endpoint/key`.
    pub path_style: bool,
    /// Objects larger than this go up in parts of this size (S3's minimum part is 5 MiB).
    pub part_size: usize,
    /// Parts uploaded at once.
    pub concurrency: usize,
    /// Tries per request (network errors, 5xx, 429).
    pub attempts: u32,
    pub timeout: Duration,
}

impl S3Config {
    pub fn new(
        endpoint: &str,
        region: &str,
        bucket: &str,
        access_key: &str,
        secret_key: &str,
    ) -> Self {
        S3Config {
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            region: region.to_owned(),
            bucket: bucket.to_owned(),
            access_key: access_key.to_owned(),
            secret_key: secret_key.to_owned(),
            path_style: true,
            part_size: 8 << 20,
            concurrency: 4,
            attempts: 4,
            timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Clone)]
pub struct S3 {
    config: Arc<S3Config>,
    credentials: Credentials,
    http: reqwest::Client,
    /// `scheme://host[:port]` the requests go to, and the `host` header they sign.
    origin: String,
    host: String,
    /// The path prefix of every key (`/bucket` path-style, empty otherwise).
    prefix: String,
}

struct Response {
    status: StatusCode,
    headers: reqwest::header::HeaderMap,
    body: Bytes,
}

impl S3 {
    pub fn new(config: S3Config) -> Result<Self, StoreError> {
        let url = Url::parse(&config.endpoint).map_err(|error| StoreError::Refused {
            status: 0,
            message: format!("endpoint: {error}"),
        })?;
        let host = url.host_str().unwrap_or_default();
        let host = if config.path_style {
            host.to_owned()
        } else {
            format!("{}.{host}", config.bucket)
        };
        let host = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        let origin = format!("{}://{host}", url.scheme());
        let prefix = if config.path_style {
            format!("/{}", sigv4::uri_encode(&config.bucket, false))
        } else {
            String::new()
        };
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| StoreError::Unavailable(error.to_string()))?;
        Ok(S3 {
            credentials: Credentials {
                access_key: config.access_key.clone(),
                secret_key: config.secret_key.clone(),
                region: config.region.clone(),
            },
            config: Arc::new(config),
            http,
            origin,
            host,
            prefix,
        })
    }

    fn path(&self, key: &str) -> String {
        format!("{}/{}", self.prefix, sigv4::uri_encode(key, true))
    }

    /// One signed request, retried.
    async fn send(
        &self,
        method: Method,
        key: &str,
        query: &[(String, String)],
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<Response, StoreError> {
        let path = self.path(key);
        let payload = if body.is_empty() {
            EMPTY_SHA256.to_owned()
        } else {
            sigv4::sha256_hex(&body)
        };
        let mut url = format!("{}{path}", self.origin);
        if !query.is_empty() {
            url.push('?');
            url.push_str(
                &query
                    .iter()
                    .map(|(k, v)| {
                        if v.is_empty() && k == "uploads" {
                            k.clone()
                        } else {
                            format!(
                                "{}={}",
                                sigv4::uri_encode(k, false),
                                sigv4::uri_encode(v, false)
                            )
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("&"),
            );
        }
        let mut last = String::new();
        for attempt in 0..self.config.attempts.max(1) {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(100 << (2 * (attempt - 1)).min(6))).await;
            }
            let extra: Vec<(&str, &str)> = content_type
                .map(|ct| ("content-type", ct))
                .into_iter()
                .collect();
            let signed = self.credentials.sign(
                &Request {
                    method: method.as_str(),
                    host: &self.host,
                    path: &path,
                    query,
                    headers: &extra,
                },
                &payload,
                SystemTime::now(),
            );
            let mut request = self.http.request(method.clone(), &url).body(body.clone());
            for (name, value) in signed
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .chain(extra.iter().copied())
            {
                request = request.header(name, value);
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let headers = response.headers().clone();
                    match response.bytes().await {
                        Ok(body)
                            if status.is_server_error()
                                || status == StatusCode::TOO_MANY_REQUESTS =>
                        {
                            last = format!(
                                "{status}: {}",
                                String::from_utf8_lossy(&body[..body.len().min(300)])
                            );
                        }
                        Ok(body) => {
                            return Ok(Response {
                                status,
                                headers,
                                body,
                            });
                        }
                        Err(error) => last = error.to_string(),
                    }
                }
                Err(error) => last = error.to_string(),
            }
        }
        Err(StoreError::Unavailable(last))
    }

    fn refused(response: &Response) -> StoreError {
        StoreError::Refused {
            status: response.status.as_u16(),
            message: String::from_utf8_lossy(&response.body[..response.body.len().min(500)])
                .into_owned(),
        }
    }

    async fn put_multipart(
        &self,
        key: &str,
        body: Bytes,
        content_type: &str,
    ) -> Result<(), StoreError> {
        let created = self
            .send(
                Method::POST,
                key,
                &[("uploads".into(), String::new())],
                Bytes::new(),
                Some(content_type),
            )
            .await?;
        if !created.status.is_success() {
            return Err(Self::refused(&created));
        }
        let upload_id =
            xml_value(&created.body, "UploadId").ok_or_else(|| StoreError::Refused {
                status: 200,
                message: "no UploadId".into(),
            })?;
        let result = self.upload_parts(key, &upload_id, body).await;
        match result {
            Ok(etags) => {
                let mut xml = String::from("<CompleteMultipartUpload>");
                for (k, etag) in etags.iter().enumerate() {
                    xml.push_str(&format!(
                        "<Part><PartNumber>{}</PartNumber><ETag>{etag}</ETag></Part>",
                        k + 1
                    ));
                }
                xml.push_str("</CompleteMultipartUpload>");
                let done = self
                    .send(
                        Method::POST,
                        key,
                        &[("uploadId".into(), upload_id.clone())],
                        Bytes::from(xml),
                        Some("application/xml"),
                    )
                    .await?;
                // S3 can answer 200 with an <Error> body when completing.
                if done.status.is_success() && xml_value(&done.body, "Code").is_none() {
                    Ok(())
                } else {
                    Err(Self::refused(&done))
                }
            }
            Err(error) => {
                let _ = self
                    .send(
                        Method::DELETE,
                        key,
                        &[("uploadId".into(), upload_id)],
                        Bytes::new(),
                        None,
                    )
                    .await;
                Err(error)
            }
        }
    }

    async fn upload_parts(
        &self,
        key: &str,
        upload_id: &str,
        body: Bytes,
    ) -> Result<Vec<String>, StoreError> {
        let size = self.config.part_size.max(5 << 20);
        let limit = Arc::new(Semaphore::new(self.config.concurrency.max(1)));
        let mut tasks = Vec::new();
        for (k, start) in (0..body.len()).step_by(size).enumerate() {
            let part = body.slice(start..(start + size).min(body.len()));
            let (store, key, upload_id, limit) = (
                self.clone(),
                key.to_owned(),
                upload_id.to_owned(),
                limit.clone(),
            );
            tasks.push(tokio::spawn(async move {
                let _slot = limit.acquire_owned().await.expect("semaphore open");
                let query = [
                    ("partNumber".to_owned(), (k + 1).to_string()),
                    ("uploadId".to_owned(), upload_id),
                ];
                let response = store.send(Method::PUT, &key, &query, part, None).await?;
                if !response.status.is_success() {
                    return Err(Self::refused(&response));
                }
                response
                    .headers
                    .get("etag")
                    .and_then(|etag| etag.to_str().ok())
                    .map(str::to_owned)
                    .ok_or_else(|| StoreError::Refused {
                        status: 200,
                        message: "no ETag".into(),
                    })
            }));
        }
        let mut etags = Vec::with_capacity(tasks.len());
        for task in tasks {
            etags.push(
                task.await
                    .map_err(|error| StoreError::Unavailable(error.to_string()))??,
            );
        }
        Ok(etags)
    }
}

/// The text of the first `<tag>` of an S3 XML answer.
fn xml_value(body: &[u8], tag: &str) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(text[start..end].to_owned())
}

impl ObjectStore for S3 {
    async fn put(&self, key: &str, body: Bytes, content_type: &str) -> Result<(), StoreError> {
        if body.len() > self.config.part_size.max(5 << 20) {
            return self.put_multipart(key, body, content_type).await;
        }
        let response = self
            .send(Method::PUT, key, &[], body, Some(content_type))
            .await?;
        if response.status.is_success() {
            Ok(())
        } else {
            Err(Self::refused(&response))
        }
    }

    async fn get(&self, key: &str) -> Result<Option<Bytes>, StoreError> {
        let response = self.send(Method::GET, key, &[], Bytes::new(), None).await?;
        match response.status {
            StatusCode::OK => Ok(Some(response.body)),
            StatusCode::NOT_FOUND => Ok(None),
            _ => Err(Self::refused(&response)),
        }
    }

    async fn head(&self, key: &str) -> Result<Option<u64>, StoreError> {
        let response = self
            .send(Method::HEAD, key, &[], Bytes::new(), None)
            .await?;
        match response.status {
            StatusCode::OK => Ok(response
                .headers
                .get("content-length")
                .and_then(|value| value.to_str().ok()?.parse().ok())),
            StatusCode::NOT_FOUND => Ok(None),
            _ => Err(Self::refused(&response)),
        }
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        let response = self
            .send(Method::DELETE, key, &[], Bytes::new(), None)
            .await?;
        if response.status.is_success() || response.status == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Self::refused(&response))
        }
    }

    fn presign_get(&self, key: &str, ttl: Duration) -> Option<String> {
        let path = self.path(key);
        let query =
            self.credentials
                .presign(&self.host, &path, ttl.as_secs().max(1), SystemTime::now());
        Some(format!("{}{path}?{query}", self.origin))
    }
}
