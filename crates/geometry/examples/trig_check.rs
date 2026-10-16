//! Compares the crate's trigonometry with V8's on recorded inputs (lane L1 tooling): rows of
//! [x, y, sin x, cos x, tan x, atan2(y, x), acos(x/10 clamped), pow(x, 2)] as little-endian f64, written by
//! scripts/geometry/trig-record.cjs. Prints how many results differ in any bit, per function.
fn main() {
    let path = std::env::args().nth(1).expect("trig.bin");
    let bytes = std::fs::read(path).expect("read");
    let values: Vec<f64> = bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect();
    let names = ["sin", "cos", "tan", "atan2", "acos", "pow2"];
    let mut diffs = [0usize; 6];
    let rows = values.len() / 8;
    for row in values.as_chunks::<8>().0 {
        let (x, y) = (row[0], row[1]);
        let ours = [
            morfa_geometry::js::sin(x),
            morfa_geometry::js::cos(x),
            morfa_geometry::js::tan(x),
            morfa_geometry::js::atan2(y, x),
            morfa_geometry::js::acos((x / 10.0).clamp(-1.0, 1.0)),
            morfa_geometry::js::pow(x, 2.0),
        ];
        for k in 0..6 {
            if ours[k].to_bits() != row[2 + k].to_bits() {
                diffs[k] += 1;
                if diffs[k] <= 3 {
                    eprintln!(
                        "{} x={x:e}: ours {:e}, V8 {:e}",
                        names[k],
                        ours[k],
                        row[2 + k]
                    );
                }
            }
        }
    }
    for k in 0..6 {
        println!("{:6} {} / {rows} differ", names[k], diffs[k]);
    }
}
