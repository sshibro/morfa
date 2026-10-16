//! Running `storagesim node` as a child process and reading its events.
#![allow(dead_code)]

use morfa_journal::testdb::TestDb;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const RECTS: usize = 2000;
pub const LAYERS: usize = 20;

/// Files whose document is the simulation's initial one, with free leases.
pub async fn files(db: &TestDb, n: usize) -> Vec<String> {
    let client = db.client().await;
    let document = morfa_storagesim::document(RECTS);
    let mut files = Vec::new();
    for _ in 0..n {
        let file = db.file(&client).await;
        client
            .execute("UPDATE design_files SET document=$2,bytes=octet_length($2),node_count=$3 WHERE id=$1", &[&file, &document, &((RECTS + 1) as i32)])
            .await
            .unwrap();
        files.push(file);
    }
    files
}

/// Events as the node printed them: kind, file, the rest.
pub type Events = Arc<Mutex<Vec<(String, String, Vec<String>)>>>;

pub struct Node {
    pub child: Child,
    pub events: Events,
    reader: tokio::task::JoinHandle<()>,
}

impl Node {
    pub fn spawn(
        db: &TestDb,
        store: &std::path::Path,
        name: &str,
        files: &[String],
        extra: &[&str],
    ) -> Node {
        let mut child = Command::new(env!("CARGO_BIN_EXE_storagesim"))
            .args([
                "node",
                "--db",
                &db.url,
                "--store",
                store.to_str().unwrap(),
                "--node",
                name,
                "--files",
                &files.join(","),
            ])
            .args([
                "--rects",
                &RECTS.to_string(),
                "--layers",
                &LAYERS.to_string(),
            ])
            .args(extra)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn storagesim");
        let stdout = child.stdout.take().unwrap();
        let events: Events = Arc::default();
        let sink = events.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut parts = line.split(' ').map(str::to_owned);
                let kind = parts.next().unwrap_or_default();
                let file = parts.next().unwrap_or_default();
                sink.lock().unwrap().push((kind, file, parts.collect()));
            }
        });
        Node {
            child,
            events,
            reader,
        }
    }

    pub fn count(&self, kind: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| k == kind)
            .count()
    }

    pub fn of(&self, kind: &str) -> Vec<(String, Vec<String>)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| k == kind)
            .map(|(_, f, rest)| (f.clone(), rest.clone()))
            .collect()
    }

    /// The highest acked version per file.
    pub fn acked(&self) -> HashMap<String, u64> {
        let mut acked = HashMap::new();
        for (file, rest) in self.of("ACK") {
            let version: u64 = rest[0].parse().unwrap();
            let top = acked.entry(file).or_insert(0);
            *top = version.max(*top);
        }
        acked
    }

    pub async fn wait_for(&self, kind: &str, n: usize, within: std::time::Duration) {
        let deadline = std::time::Instant::now() + within;
        while self.count(kind) < n {
            assert!(
                std::time::Instant::now() < deadline,
                "{n} {kind} events in {within:?}; got {:?}",
                self.tail()
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    pub fn tail(&self) -> Vec<(String, String, Vec<String>)> {
        let events = self.events.lock().unwrap();
        events.iter().rev().take(5).cloned().collect()
    }

    /// `kill -9`; the events read until then stay.
    pub async fn kill(mut self) -> Events {
        self.child.kill().await.unwrap();
        let _ = self.reader.await;
        self.events
    }

    pub async fn finish(mut self) -> Events {
        let status = tokio::time::timeout(std::time::Duration::from_secs(60), self.child.wait())
            .await
            .expect("the node stops")
            .unwrap();
        assert!(status.success(), "{status}");
        let _ = self.reader.await;
        self.events
    }
}

pub fn temp_store(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("morfa-b2-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
