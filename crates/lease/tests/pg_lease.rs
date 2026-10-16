//! PgLease and Keeper against PostgreSQL (MORFA_B2_PG_URL; skipped without it).

use morfa_journal::testdb::TestDb;
use morfa_lease::{Keeper, Lease, LeaseState, PgLease};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_owner_at_a_time_and_every_owner_a_larger_fence() {
    let Some(db) = TestDb::create("one_owner_at_a_time_and_every_owner_a_larger_fence").await
    else {
        return;
    };
    let file = db.file(&db.client().await).await;
    let lease = PgLease::new(&db.url);
    let ttl = Duration::from_millis(400);
    let before = Instant::now();
    let a = lease.acquire(&file, "node-a", ttl).await.unwrap().unwrap();
    assert_eq!(a.fence, 1);
    assert!(a.valid_until >= before + ttl && a.valid_until <= Instant::now() + ttl);
    assert_eq!(
        lease.acquire(&file, "node-b", ttl).await.unwrap(),
        None,
        "a live lease is not taken"
    );
    let holder = lease.holder(&file).await.unwrap().unwrap();
    assert_eq!(
        (holder.node.as_deref(), holder.fence, holder.live),
        (Some("node-a"), 1, true)
    );
    // Renewal keeps it; a renewal under another fence does not.
    assert!(
        lease
            .renew(&file, "node-a", 1, ttl)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        lease
            .renew(&file, "node-a", 7, ttl)
            .await
            .unwrap()
            .is_none()
    );
    // The same node restarted takes it back at once, under a new fence.
    let a2 = lease.acquire(&file, "node-a", ttl).await.unwrap().unwrap();
    assert_eq!(a2.fence, 2);
    assert!(
        lease
            .renew(&file, "node-a", 1, ttl)
            .await
            .unwrap()
            .is_none(),
        "the old process is fenced"
    );
    // Once the lease ran out, another node takes it.
    tokio::time::sleep(ttl + Duration::from_millis(50)).await;
    assert!(!lease.holder(&file).await.unwrap().unwrap().live);
    let b = lease.acquire(&file, "node-b", ttl).await.unwrap().unwrap();
    assert_eq!(b.fence, 3);
    assert!(
        lease
            .renew(&file, "node-a", 2, ttl)
            .await
            .unwrap()
            .is_none()
    );
    // A release by the stale owner changes nothing; the owner's own frees the file and keeps the fence.
    lease.release(&file, "node-a", 2).await.unwrap();
    assert_eq!(
        lease.holder(&file).await.unwrap().unwrap().node.as_deref(),
        Some("node-b")
    );
    lease.release(&file, "node-b", 3).await.unwrap();
    let holder = lease.holder(&file).await.unwrap().unwrap();
    assert_eq!((holder.node, holder.fence), (None, 3));
    // A dead node's files are freed at once.
    lease
        .acquire(&file, "node-c", Duration::from_secs(15))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.expire_node("node-c").await.unwrap(), 1);
    assert_eq!(
        lease
            .acquire(&file, "node-d", ttl)
            .await
            .unwrap()
            .unwrap()
            .fence,
        5
    );
    assert_eq!(
        lease
            .holder("00000000-0000-4000-8000-000000000000")
            .await
            .unwrap(),
        None
    );
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_keeper_renews_and_reports_loss_and_expiry() {
    let Some(db) = TestDb::create("the_keeper_renews_and_reports_loss_and_expiry").await else {
        return;
    };
    let client = db.client().await;
    let (f1, f2) = (db.file(&client).await, db.file(&client).await);
    let ttl = Duration::from_millis(500);
    let every = Duration::from_millis(100);
    let a = Keeper::start(Arc::new(PgLease::new(&db.url)), "node-a", ttl, every);
    let b = Keeper::start(Arc::new(PgLease::new(&db.url)), "node-b", ttl, every);
    let mut h1 = a.acquire(&f1).await.unwrap().unwrap();
    let mut h2 = a.acquire(&f2).await.unwrap().unwrap();
    // Renewed past its first TTL.
    tokio::time::sleep(ttl * 2).await;
    assert!(h1.valid() && h2.valid());
    assert!(b.acquire(&f1).await.unwrap().is_none());
    // api expires node-a (its health check failed) and node-b takes f1: node-a learns at its next renewal.
    PgLease::new(&db.url).expire_node("node-a").await.unwrap();
    let taken = b.acquire(&f1).await.unwrap().unwrap();
    assert_eq!(taken.fence, h1.fence + 1);
    let started = Instant::now();
    assert_eq!(h1.ended().await, LeaseState::Lost);
    assert!(started.elapsed() < ttl);
    // f2 was freed too; node-a's renewal no longer finds it under node-a either.
    assert_eq!(h2.ended().await, LeaseState::Lost);
    assert!(a.is_empty());
    // A node that stops renewing (dead): its lease runs out locally at the deadline, and another node takes the file.
    let mut h3 = a.acquire(&f2).await.unwrap().unwrap();
    drop(a);
    // Checked against the handle's own deadline, not the wall clock since the drop (a loaded machine may run
    // this thread late): the deadline is at most one TTL away, `valid()` holds before it and turns false at it
    // exactly, and `ended()` never reports the expiry early.
    let dropped = Instant::now();
    let LeaseState::Held { valid_until } = h3.state() else {
        panic!("h3 was just acquired: {:?}", h3.state());
    };
    assert!(valid_until <= dropped + ttl);
    loop {
        let before = Instant::now();
        let valid = h3.valid();
        if Instant::now() < valid_until {
            assert!(
                valid,
                "invalid {:?} before its deadline",
                valid_until - before
            );
        } else if before >= valid_until {
            assert!(
                !valid,
                "valid {:?} after its deadline",
                before - valid_until
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep_until(valid_until.into()).await;
    assert!(!h3.valid());
    assert_eq!(h3.ended().await, LeaseState::Expired);
    assert!(Instant::now() >= valid_until);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(b.acquire(&f2).await.unwrap().is_some());
    b.release(taken).await.unwrap();
    assert_eq!(b.len(), 1);
    db.drop_db().await;
}
