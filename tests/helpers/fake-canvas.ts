// A stand-in for the browser's 2D canvas in node, for driving the scene renderer (src/design/engine/render/) in unit
// tests. Every drawing call is accepted and does nothing, except what the tests count: on a watched canvas, how many
// device pixels `drawImage` covers inside the current clip (rectangles added with `rect` and kept with `clip`, under
// the identity transform the renderer composites with), and a clock the test owns that painting advances.

type Box = {x: number; y: number; width: number; height: number};

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bottom > y ? {x, y, width: r - x, height: bottom - y} : null;
};

export type DrawCounter = {calls: number; area: number};

export class FakeContext {
  /** drawImage onto this canvas, since the last reset. */
  readonly drawn: DrawCounter = {calls: 0, area: 0};
  private clips: Box[][] = [];
  private clip_: Box[];
  private path: Box[] = [];
  private props = new Map<string, unknown>();

  constructor(readonly canvas: FakeCanvas, private readonly clock: FakeClock) {
    this.clip_ = [{x: 0, y: 0, width: Infinity, height: Infinity}];
    return new Proxy(this, {
      get: (target, key) => {
        if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
        if (typeof key === 'string' && target.props.has(key)) return target.props.get(key);
        if (key === 'measureText') return (text: string) => ({width: text.length * 6});
        if (key === 'getImageData' || key === 'createImageData') return (_x: number, _y: number, w = 1, h = 1) => ({data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h});
        if (key === 'createPattern') return () => ({setTransform() {}});
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createConicGradient') return () => ({addColorStop() {}});
        if (key === 'getTransform') return () => ({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0});
        if (key === 'getLineDash') return () => [];
        return () => {};
      },
      set: (target, key, value) => {
        if (key in target) (target as unknown as Record<string | symbol, unknown>)[key] = value;
        else if (typeof key === 'string') target.props.set(key, value);
        return true;
      },
    });
  }

  save() {
    this.clips.push(this.clip_);
  }

  restore() {
    this.clip_ = this.clips.pop() ?? [{x: 0, y: 0, width: Infinity, height: Infinity}];
  }

  beginPath() {
    this.path = [];
  }

  rect(x: number, y: number, width: number, height: number) {
    this.path.push({x, y, width, height});
  }

  clip(path?: unknown) {
    // A Path2D clip (a shape in the painter) is not tracked: only the renderer's rectangle clips matter here.
    if (path) return;
    const next: Box[] = [];
    for (const a of this.clip_) for (const b of this.path) {
      const both = intersect(a, b);
      if (both) next.push(both);
    }
    this.clip_ = next;
  }

  fillRect() {
    // Painting a tile starts with its background: that is where tile time goes.
    if (this.canvas.paints) this.clock.paint();
  }

  drawImage(source: {width: number; height: number}, ...rest: number[]) {
    let dx: number, dy: number, dw: number, dh: number;
    if (rest.length === 2) [dx, dy, dw, dh] = [rest[0], rest[1], source.width, source.height];
    else if (rest.length === 4) [dx, dy, dw, dh] = rest as [number, number, number, number];
    else [dx, dy, dw, dh] = [rest[4], rest[5], rest[6], rest[7]];
    this.drawn.calls++;
    const target: Box = {x: 0, y: 0, width: this.canvas.width, height: this.canvas.height};
    const dest = intersect({x: dx, y: dy, width: dw, height: dh}, target);
    if (!dest) return;
    for (const clip of this.clip_) {
      const part = intersect(dest, clip);
      if (part) this.drawn.area += part.width * part.height;
    }
  }
}

export class FakeCanvas {
  /** Painting into it advances the clock (tiles and layers; not the visible canvas a test watches). */
  paints = true;
  private context: FakeContext | null = null;
  constructor(public width: number, public height: number, private readonly clock: FakeClock = sharedClock) {}
  getContext(): FakeContext {
    return (this.context ??= new FakeContext(this, this.clock));
  }
}

/** The time `performance.now()` reports while installed; painting a tile (its background fill) takes `paintMs`. */
export class FakeClock {
  ms = 1000;
  paintMs = 0;
  paint() {
    this.ms += this.paintMs;
  }
}

const sharedClock = new FakeClock();

/** Puts OffscreenCanvas, Path2D, DOMMatrix and performance.now in place; returns the clock and an undo. */
export function installFakeCanvas(): {clock: FakeClock; uninstall: () => void} {
  const g = globalThis as Record<string, unknown>;
  const saved = {OffscreenCanvas: g.OffscreenCanvas, Path2D: g.Path2D, DOMMatrix: g.DOMMatrix};
  const savedNow = performance.now;
  g.OffscreenCanvas = class extends FakeCanvas {
    constructor(width: number, height: number) {
      super(width, height, sharedClock);
    }
  };
  g.Path2D = class {
    addPath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    ellipse() {}
    rect() {}
    roundRect() {}
    closePath() {}
  };
  g.DOMMatrix = class {
    constructor(readonly values?: number[]) {}
  };
  performance.now = () => sharedClock.ms;
  return {
    clock: sharedClock,
    uninstall() {
      Object.assign(g, saved);
      performance.now = savedNow;
    },
  };
}
