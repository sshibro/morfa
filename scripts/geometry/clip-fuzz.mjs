// Differential fuzzing of crates/geometry/src/clip (the Rust port of polygon-clipping 0.15.7).
//
// Generates random MultiPolygon inputs, runs polygon-clipping on them and writes the cases
// with the JS result (or the fact that it threw) to a token file that
// `cargo run --release -p morfa-geometry --example clip_check -- <file>` replays and compares
// bit for bit. Numbers are written as the hex of their IEEE-754 bits, so -0 and every last
// bit survive.
//
//   node scripts/geometry/clip-fuzz.mjs [out=/tmp/clip-cases.txt] [count=6000] [seed=1]
//   node scripts/geometry/clip-fuzz.mjs --bench [out=/tmp/clip-bench.txt] [seed=7]
//
// File format (whitespace separated tokens):
//   C <op> <ngeoms> <geom>... (OK <geom> | ERR <message kind, spaces as _> | HANG)
//
// Cases run in worker threads; a case the JS has not finished after CLIP_FUZZ_TIMEOUT ms
// (default 60 000) is recorded as HANG: polygon-clipping can loop forever on some degenerate
// inputs (its sweep-line tree's prev()/next() cycling), where the Rust port returns an error.
//   <geom> = G <npolys> (P <nrings> (R <npts> (<xbits> <ybits>)...)...)...

import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import polygonClipping from "polygon-clipping";

const OPS = ["union", "intersection", "xor", "difference"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buf = new DataView(new ArrayBuffer(8));
function hex(v) {
  buf.setFloat64(0, v);
  return buf.getBigUint64(0).toString(16).padStart(16, "0");
}

function encodeGeom(mp, out) {
  out.push("G", mp.length);
  for (const poly of mp) {
    out.push("P", poly.length);
    for (const ring of poly) {
      out.push("R", ring.length);
      for (const [x, y] of ring) out.push(hex(x), hex(y));
    }
  }
}

// ---- generators ----

function makeGen(rand) {
  const r = (a, b) => a + (b - a) * rand();
  const ri = (a, b) => Math.floor(r(a, b + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const circle = (cx, cy, rad, n, ccw = true, ry = rad, rot = 0) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = rot + ((ccw ? 1 : -1) * 2 * Math.PI * i) / n;
      pts.push([cx + rad * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    return pts;
  };
  const star = (cx, cy, rad, n) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      const rr = rad * r(0.3, 1);
      pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
    }
    return pts;
  };
  const gridRing = (g, n, off = [0, 0]) => {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([off[0] + ri(0, g), off[1] + ri(0, g)]);
    return pts;
  };
  const rect = (x, y, w, h) => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const close = (ring) => (rand() < 0.7 ? [...ring, ring[0]] : ring);
  // (no `+ 0` when there is no offset: it would turn the -0 of a mirrored 0 into +0)
  const scaleRing = (ring, s, dx, dy) => ring.map(([x, y]) => [dx ? x * s + dx : x * s, dy ? y * s + dy : y * s]);
  const jitter = (ring, e) => ring.map(([x, y]) => [x + (rand() < 0.5 ? 0 : r(-e, e)), y + (rand() < 0.5 ? 0 : r(-e, e))]);
  const withRepeats = (ring) => {
    const out = [];
    for (const p of ring) {
      out.push(p);
      if (rand() < 0.05) out.push([p[0], p[1]]);
    }
    return out;
  };
  const collinear = (ring) => {
    // insert midpoints on edges
    const out = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      out.push(a);
      if (rand() < 0.3) out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return out;
  };

  // one ring of some kind, in roughly [0, 10]^2 space
  const ringKinds = [
    () => circle(r(2, 8), r(2, 8), r(0.5, 4), ri(3, 64), rand() < 0.7, r(0.5, 4), r(0, 6.3)),
    () => star(r(2, 8), r(2, 8), r(1, 5), ri(5, 80)),
    () => gridRing(ri(2, 10), ri(3, 12)),
    () => gridRing(ri(4, 20), ri(3, 30)).map(([x, y]) => [x / 2, y / 2]),
    () => rect(ri(0, 6), ri(0, 6), ri(1, 5), ri(1, 5)),
    () => rect(r(0, 6), r(0, 6), r(0.1, 5), r(0.1, 5)),
    () => collinear(rect(ri(0, 6), ri(0, 6), ri(1, 5), ri(1, 5))),
    () => {
      const n = ri(3, 20);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push([r(0, 10), r(0, 10)]);
      return pts;
    },
    () => circle(5, 5, pick([1, 2, 3, 4]), pick([4, 8, 16, 32]), true), // shared vertices between operands
  ];

  const polygon = () => {
    const ext = pick(ringKinds)();
    const poly = [ext];
    if (rand() < 0.3) {
      // a hole: shrink a circle inside, or random kind
      const xs = ext.map((p) => p[0]);
      const ys = ext.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const w = Math.max(...xs) - Math.min(...xs);
      const nh = ri(1, 2);
      for (let k = 0; k < nh; k++) {
        poly.push(rand() < 0.6 ? circle(cx + r(-w, w) / 8, cy + r(-w, w) / 8, (w / 4) * r(0.2, 1), ri(3, 32), rand() < 0.5) : pick(ringKinds)());
      }
    }
    return poly;
  };

  const multiPolygon = () => {
    const n = rand() < 0.03 ? 0 : ri(1, 3);
    const mp = [];
    for (let i = 0; i < n; i++) mp.push(polygon());
    return mp;
  };

  // per-case transform of all operands: scale (tiny/huge), offsets, jitter, repeats
  const transform = (geoms) => {
    const mode = rand();
    let s = 1;
    let dx = 0;
    let dy = 0;
    if (mode < 0.1) s = Math.pow(10, -ri(3, 12));
    else if (mode < 0.2) s = Math.pow(10, ri(3, 15));
    else if (mode < 0.3) {
      dx = pick([1e6, -1e7, 123456.789, 1e12]);
      dy = pick([1e6, -3e5, 987.125, 1e12]);
    } else if (mode < 0.4) s = r(0.01, 100);
    else if (mode < 0.5) s = -1; // mirrored: 0 becomes -0
    const jit = rand() < 0.15 ? pick([1e-15, 1e-12, 1e-9, 1e-6]) : 0;
    return geoms.map((mp) =>
      mp.map((poly) =>
        poly.map((ring) => {
          let rr = scaleRing(ring, s, dx, dy);
          if (jit) rr = jitter(rr, jit * s * 10);
          if (rand() < 0.1) rr = withRepeats(rr);
          return close(rr);
        }),
      ),
    );
  };

  const caseGeoms = () => {
    const n = ri(2, 8);
    const geoms = [];
    for (let i = 0; i < n; i++) {
      if (i > 0 && rand() < 0.15) {
        // exact duplicate or translated copy of an earlier operand: overlapping edges
        const src = pick(geoms);
        const t = rand() < 0.5 ? [0, 0] : [ri(-2, 2), ri(-2, 2)];
        geoms.push(src.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + t[0], y + t[1]]))));
      } else geoms.push(multiPolygon());
    }
    return transform(geoms);
  };

  return { caseGeoms, star, circle, r, ri };
}

function runCase(op, geoms) {
  try {
    return { ok: polygonClipping[op](geoms[0], ...geoms.slice(1)) };
  } catch (e) {
    return { err: String(e && e.message) };
  }
}

// The stable part of an error message (before any coordinates / ids).
function errorKind(message) {
  return message.split(/[\[#]/)[0].trim();
}

function encodeCase(op, geoms, res, out) {
  out.push("C", op, geoms.length);
  for (const g of geoms) encodeGeom(g, out);
  if (res.hang) out.push("HANG");
  else if (res.err !== undefined) out.push("ERR", errorKind(res.err).replace(/\s+/g, "_"));
  else {
    out.push("OK");
    encodeGeom(res.ok, out);
  }
  out.push("\n");
}

/// Runs the cases on worker threads, `null` results meaning the JS did not finish in time.
async function runAll(cases) {
  const timeout = Number(process.env.CLIP_FUZZ_TIMEOUT ?? 60000);
  const results = new Array(cases.length);
  let next = 0;
  const lane = async () => {
    let worker = new Worker(new URL(import.meta.url));
    while (next < cases.length) {
      const i = next++;
      if (process.env.CLIP_FUZZ_TRACE) process.stderr.write(`case ${i}\n`);
      const res = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ hang: true }), timeout);
        worker.once("message", (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        worker.postMessage(cases[i]);
      });
      if (res.hang) {
        worker.removeAllListeners("message");
        await worker.terminate();
        worker = new Worker(new URL(import.meta.url));
      }
      results[i] = res;
    }
    await worker.terminate();
  };
  const lanes = Math.max(1, Math.min(Number(process.env.CLIP_FUZZ_WORKERS ?? availableParallelism()), 8));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

const args = process.argv.slice(2);
if (!isMainThread) {
  parentPort.on("message", ({ op, geoms }) => parentPort.postMessage(runCase(op, geoms)));
} else if (args[0] === "--bench") {
  const file = args[1] ?? "/tmp/clip-bench.txt";
  const rand = mulberry32(Number(args[2] ?? 7));
  const g = makeGen(rand);
  // 200 overlapping flattened shapes (30-60 vertices) over a 1000x1000 canvas
  const geoms = [];
  for (let i = 0; i < 200; i++) {
    const n = g.ri(30, 60);
    const cx = g.r(0, 1000);
    const cy = g.r(0, 1000);
    const rad = g.r(30, 120);
    const ring = rand() < 0.5 ? g.circle(cx, cy, rad, n, true, rad * g.r(0.5, 1), g.r(0, 6)) : g.star(cx, cy, rad, n);
    geoms.push([[[...ring, ring[0]]]]);
  }
  const res = runCase("union", geoms);
  const out = [];
  encodeCase("union", geoms, res, out);
  writeFileSync(file, out.join(" "));
  // timing: warm up, then median of runs
  for (let i = 0; i < 3; i++) runCase("union", geoms);
  const times = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    runCase("union", geoms);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `JS polygon-clipping union of 200 operands: median ${times[5].toFixed(2)} ms, min ${times[0].toFixed(2)} ms` +
      ` (result ${res.err ? "ERR" : res.ok.length + " polygons"}) -> ${file}`,
  );
} else {
  const file = args[0] ?? "/tmp/clip-cases.txt";
  const count = Number(args[1] ?? 6000);
  const rand = mulberry32(Number(args[2] ?? 1));
  const g = makeGen(rand);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const op = OPS[i % 4];
    const geoms = g.caseGeoms();
    if (process.env.CLIP_FUZZ_DUMP === String(i)) {
      writeFileSync(file, JSON.stringify({ op, geoms }));
      console.log(`case ${i} input -> ${file}`);
      process.exit(0);
    }
    cases.push({ op, geoms });
  }
  const results = await runAll(cases);
  const out = [];
  const perOp = {};
  const kinds = {};
  let errors = 0;
  for (let i = 0; i < count; i++) {
    const { op, geoms } = cases[i];
    const res = results[i];
    if (res.err !== undefined || res.hang) {
      errors++;
      const k = res.hang ? "HANG (JS did not return)" : errorKind(res.err);
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    perOp[op] = (perOp[op] ?? 0) + 1;
    encodeCase(op, geoms, res, out);
  }
  writeFileSync(file, out.join(" "));
  console.log(`${count} cases (${JSON.stringify(perOp)}), ${errors} JS errors -> ${file}`);
  for (const [k, n] of Object.entries(kinds)) console.log(`  ${n} x ${k}`);
}
