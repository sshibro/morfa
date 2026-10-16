// Lane L1: records V8's Math.sin/cos/tan/atan2/acos/pow on many arguments for crates/geometry/examples/trig_check.rs:
//   node scripts/geometry/trig-record.cjs <out.bin> [rows]
//   cargo run --release -p morfa-geometry --example trig_check -- <out.bin>
// Rows of [x, y, sin x, cos x, tan x, atan2(y, x), acos(x/10 clamped), pow(x, 2)], little-endian f64. Arguments mix
// magnitudes from 1e-8 to 8e5, degree angles turned to radians as localMatrix does, and multiples of π/2 nearby.
const fs = require('node:fs');
const [out, count = '400000'] = process.argv.slice(2);
const n = Number(count);
let s = 12345;
const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const rows = new Float64Array(n * 8);
for (let i = 0; i < n; i++) {
  let x;
  switch (i % 6) {
    case 0: x = (r() * 2 - 1) * 10 ** (r() * 14 - 8); break;
    case 1: x = (-((r() * 720 - 360) * Math.PI)) / 180; break;
    case 2: x = Math.round(r() * 64 - 32) * (Math.PI / 2) + (r() - 0.5) * 1e-6; break;
    case 3: x = (r() * 2 - 1) * 823000; break;
    case 4: x = (r() * 2 - 1) * Math.PI * 2; break;
    default: x = (r() * 2 - 1) * [1, 4, 10, 100, 1e4][i % 5];
  }
  const y = (r() * 2 - 1) * 10;
  rows.set([x, y, Math.sin(x), Math.cos(x), Math.tan(x), Math.atan2(y, x), Math.acos(Math.max(-1, Math.min(1, x / 10))), Math.pow(x, 2)], i * 8);
}
fs.writeFileSync(out, Buffer.from(rows.buffer));
