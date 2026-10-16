//! Times reading a document (profiling aid): `cargo run --release --example parse -- file.json`. Into a whole
//! [`morfa_ops::Value`], and as a [`morfa_ops::stored::StoredDocument`] (the node table left as slices), each written
//! back; the two texts must be equal.
fn main() {
    let path = std::env::args().nth(1).expect("a JSON file");
    let text = std::fs::read_to_string(path).expect("readable");
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let value = morfa_ops::Value::from_json(&text).expect("JSON");
        let parsed = started.elapsed();
        let started = std::time::Instant::now();
        let json = value.to_json();
        let written = started.elapsed();
        let started = std::time::Instant::now();
        let stored = morfa_ops::stored::StoredDocument::from_json(&text).expect("JSON");
        let scanned = started.elapsed();
        let started = std::time::Instant::now();
        let again = stored.to_json();
        println!(
            "parse {parsed:?}, write {written:?}; stored: scan {scanned:?}, write {:?}; {} bytes, equal {}",
            started.elapsed(),
            json.len(),
            again == json
        );
    }
}
