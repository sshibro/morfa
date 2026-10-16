//! A PostgreSQL connection that opens on first use and again after it broke, and prepares each statement once
//! (one round trip per call afterwards). Shared by the B2 crates.

use std::collections::HashMap;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, NoTls, Statement};

/// One connection, opened on first use and again after it broke, with the statements it prepared.
pub struct Conn {
    url: String,
    setup: Option<&'static str>,
    open: Option<(Client, HashMap<&'static str, Statement>)>,
}

impl Conn {
    pub fn new(url: &str) -> Self {
        Conn {
            url: url.to_owned(),
            setup: None,
            open: None,
        }
    }

    /// Runs `sql` (no parameters) on every connection this opens, before its first statement.
    pub fn with_setup(mut self, sql: &'static str) -> Self {
        self.setup = Some(sql);
        self
    }

    async fn client(
        &mut self,
    ) -> Result<&mut (Client, HashMap<&'static str, Statement>), tokio_postgres::Error> {
        if self
            .open
            .as_ref()
            .is_some_and(|(client, _)| client.is_closed())
        {
            self.open = None;
        }
        if self.open.is_none() {
            let (client, connection) = tokio_postgres::connect(&self.url, NoTls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            if let Some(setup) = self.setup {
                client.batch_execute(setup).await?;
            }
            self.open = Some((client, HashMap::new()));
        }
        Ok(self.open.as_mut().expect("opened above"))
    }

    pub async fn query(
        &mut self,
        sql: &'static str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<tokio_postgres::Row>, tokio_postgres::Error> {
        let (client, prepared) = self.client().await?;
        let statement = match prepared.get(sql) {
            Some(statement) => statement.clone(),
            None => {
                let statement = client.prepare(sql).await?;
                prepared.insert(sql, statement.clone());
                statement
            }
        };
        client.query(&statement, params).await
    }

    pub async fn execute(
        &mut self,
        sql: &'static str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, tokio_postgres::Error> {
        let (client, prepared) = self.client().await?;
        let statement = match prepared.get(sql) {
            Some(statement) => statement.clone(),
            None => {
                let statement = client.prepare(sql).await?;
                prepared.insert(sql, statement.clone());
                statement
            }
        };
        client.execute(&statement, params).await
    }

    /// Runs statements without parameters (`BEGIN …`, `COMMIT`) in one round trip.
    pub async fn batch(&mut self, sql: &str) -> Result<(), tokio_postgres::Error> {
        let (client, _) = self.client().await?;
        client.batch_execute(sql).await
    }

    /// Drops the connection; the next call opens a new one.
    pub fn reset(&mut self) {
        self.open = None;
    }
}

/// A server error about the data (a bound, a type), as opposed to the connection or the server's state.
pub fn refused_for_data(error: &tokio_postgres::Error) -> bool {
    match error.code() {
        None => false,
        Some(code) => !matches!(&code.code()[..2], "08" | "40" | "53" | "57" | "58"),
    }
}
