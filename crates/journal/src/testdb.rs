//! A throwaway database for the tests of the PostgreSQL crates: created on the server `MORFA_B2_PG_URL` names (a role that
//! may create databases, e.g. a bootstrap role), migrated with
//! `server/postgresql/schema/NNN-*.sql` in order, dropped by [`TestDb::drop_db`]. Tests skip (and say so) when the
//! variable is not set: cloud containers run without PostgreSQL.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_postgres::{Client, NoTls};

pub struct TestDb {
    pub url: String,
    admin: String,
    name: String,
}

fn with_database(url: &str, database: &str) -> String {
    match url.rfind('/') {
        Some(slash) if url[..slash].contains("://") && url[..slash].contains('@') => {
            format!("{}/{database}", &url[..slash])
        }
        _ => format!("{url} dbname={database}"),
    }
}

async fn connect(url: &str) -> Client {
    let (client, connection) = tokio_postgres::connect(url, NoTls)
        .await
        .expect("connect to the test server");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

fn schema_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server/postgresql/schema")
}

impl TestDb {
    /// A fresh migrated database, or `None` (with a note on stderr) when `MORFA_B2_PG_URL` is not set.
    pub async fn create(test: &str) -> Option<TestDb> {
        let Ok(admin) = std::env::var("MORFA_B2_PG_URL") else {
            eprintln!("skipped {test}: MORFA_B2_PG_URL is not set");
            return None;
        };
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            "b2_{}_{}_{}",
            std::process::id(),
            nanos % 1_000_000_000_000,
            COUNT.fetch_add(1, Ordering::Relaxed)
        );
        connect(&admin)
            .await
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await
            .expect("create the test database");
        let url = with_database(&admin, &name);
        let client = connect(&url).await;
        let mut files: Vec<PathBuf> = std::fs::read_dir(schema_dir())
            .expect("server/postgresql/schema")
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.len() > 4
                            && name[..3].bytes().all(|b| b.is_ascii_digit())
                            && name.ends_with(".sql")
                    })
            })
            .collect();
        files.sort();
        for file in files {
            let sql = std::fs::read_to_string(&file).unwrap();
            for statement in sql.split("\n-- statement-breakpoint\n") {
                if !statement.trim().is_empty() {
                    client
                        .batch_execute(statement)
                        .await
                        .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
                }
            }
        }
        Some(TestDb { url, admin, name })
    }

    pub async fn client(&self) -> Client {
        connect(&self.url).await
    }

    /// A user and a design file of theirs (version 1, an empty document); returns the file id.
    pub async fn file(&self, client: &Client) -> String {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let k = COUNT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;
        let id = format!(
            "{:08x}-0000-4000-8000-{:012x}",
            k as u32,
            nanos & 0xffff_ffff_ffff
        );
        let user = format!("user-{id}");
        client
            .execute(
                "INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')",
                &[&user, &format!("{id}@example.invalid")],
            )
            .await
            .expect("insert a user");
        client
            .execute(
                "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'Design','{}',2,0)",
                &[&id, &user],
            )
            .await
            .expect("insert a design file");
        id
    }

    /// Drops the database (connections to it are closed first).
    pub async fn drop_db(self) {
        let admin = connect(&self.admin).await;
        let _ = admin
            .batch_execute(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                self.name
            ))
            .await;
    }
}
