//! Lane L1 tooling: runs `strokeArea` natively on dumped cases (JSON: [{id, geometry, style, start, end}]) to
//! reproduce a WASM failure with a Rust backtrace.
use morfa_geometry::outline::{StrokeStyle, stroke_area};
use morfa_model::{StrokeMarker, VectorPath};
use serde_json::Value;

fn main() {
    let stack = std::env::var("STACK_KB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(8192)
        * 1024;
    std::thread::Builder::new()
        .stack_size(stack)
        .spawn(run)
        .expect("thread")
        .join()
        .expect("join");
}

fn run() {
    let text = std::fs::read_to_string(std::env::args().nth(1).expect("cases.json")).expect("read");
    let cases: Vec<Value> = serde_json::from_str(&text).expect("json");
    for case in cases {
        let geometry: Vec<VectorPath> =
            serde_json::from_value(case["geometry"].clone()).expect("geometry");
        let s = &case["style"];
        let style = StrokeStyle {
            weight: s["weight"].as_f64().unwrap_or(0.0),
            align: serde_json::from_value(s["align"].clone()).expect("align"),
            cap: serde_json::from_value(s["cap"].clone()).expect("cap"),
            join: serde_json::from_value(s["join"].clone()).expect("join"),
            miter_limit: s["miterLimit"].as_f64().unwrap_or(4.0),
            dash_pattern: serde_json::from_value(s["dashPattern"].clone()).expect("dash"),
        };
        let start: StrokeMarker = serde_json::from_value(case["start"].clone()).expect("start");
        let end: StrokeMarker = serde_json::from_value(case["end"].clone()).expect("end");
        eprintln!("case {}", case["id"]);
        let area = stroke_area(&geometry, &style, None, start, end);
        eprintln!("  {} polygons", area.len());
    }
}
