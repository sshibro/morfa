// Prometheus metrics of the api (docs/BACKEND.md §9; TARGETS A1, A2, A5; lane B5). The text exposition format is small enough to
// write here, so no client library is added (the checkout shares one node_modules between worktrees). What is measured:
//   api_http_request_duration_seconds{method,route,status}  every request, by the route pattern (ids replaced by `:id`)
//   api_http_requests_in_flight                             requests being answered
//   api_db_pool_{total,idle,waiting}                        the PostgreSQL pool (MORFA_DATABASE_POOL_MAX sizes it)
//   process_* / nodejs_*                                    CPU, memory, descriptors, event-loop delay of this process
//   api_build_info{version,commit,instance}                 the running build
// Served on a separate private listener (METRICS_PORT on METRICS_HOST, default 127.0.0.1), never through the public app, so
// Caddy never routes it and no secret is needed for Prometheus on the same host.
import {readdirSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import type {NextFunction, Request, Response} from 'express';

/** Seconds; the A-rows' targets and ceilings (20 ms … 300 ms) each fall on a bucket edge. */
export const HTTP_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.25, 0.3, 0.5, 1, 2.5, 5, 10, 30];

type Labels = Record<string, string>;
const labelText = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length ? '{' + entries.map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',') + '}' : '';
};
const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

/** A histogram with labels: cumulative buckets, sum and count per label set. */
export class Histogram {
  private readonly series = new Map<string, {labels: Labels; counts: number[]; sum: number; count: number}>();
  constructor(readonly name: string, readonly help: string, readonly buckets: readonly number[] = HTTP_BUCKETS) {}
  observe(labels: Labels, seconds: number) {
    const key = keyOf(labels);
    let entry = this.series.get(key);
    if (!entry) this.series.set(key, (entry = {labels, counts: this.buckets.map(() => 0), sum: 0, count: 0}));
    for (let i = 0; i < this.buckets.length; i++) if (seconds <= this.buckets[i]) entry.counts[i]++;
    entry.sum += seconds;
    entry.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const {labels, counts, sum, count} of this.series.values()) {
      this.buckets.forEach((bound, i) => lines.push(`${this.name}_bucket${labelText({...labels, le: String(bound)})} ${counts[i]}`));
      lines.push(`${this.name}_bucket${labelText({...labels, le: '+Inf'})} ${count}`);
      lines.push(`${this.name}_sum${labelText(labels)} ${sum}`, `${this.name}_count${labelText(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

/** Route patterns as labels: the matched route's pattern after its mount path, whose real ids (uuids and the like) become `:id`.
 *  Lower-case words stay; anything else in the mount path is a parameter value. Unmatched requests share one label. */
export function routeLabel(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const pattern = (req.route as {path?: unknown} | undefined)?.path;
  if (typeof pattern !== 'string') return 'unmatched';
  const base = (req.baseUrl || '')
    .split('/')
    .map(segment => (segment === '' || /^[a-z][a-z-]*$/.test(segment) ? segment : ':id'))
    .join('/');
  const route = (base + (pattern === '/' && base ? '' : pattern)).replace(/\/{2,}/g, '/');
  return route || '/';
}

export const httpDuration = new Histogram('api_http_request_duration_seconds', 'Request received to response finished, by route pattern.');
let inFlight = 0;

/** Express middleware: times every request by method, route pattern and status class. */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  inFlight++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight--;
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    httpDuration.observe({method: req.method, route: routeLabel(req), status: `${Math.floor(res.statusCode / 100)}xx`}, seconds);
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

type PoolStatistics = {total: number; idle: number; waiting: number};
let poolStatistics: (() => PoolStatistics) | null = null;
/** server/index.ts hands the database's pool counters over (db.getStatistics). */
export const watchPool = (read: () => PoolStatistics) => void (poolStatistics = read);

const eventLoop = monitorEventLoopDelay({resolution: 10});
eventLoop.enable();
const startedAt = Date.now() / 1000 - process.uptime();

function openFds(): number | null {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

const gauge = (name: string, help: string, value: number, labels: Labels = {}) =>
  `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labelText(labels)} ${value}`;
const counter = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;

/** The whole exposition. Event-loop delay percentiles cover the time since the previous scrape (one Prometheus per host). */
export function renderMetrics(): string {
  const cpu = process.cpuUsage(), memory = process.memoryUsage();
  const parts = [
    httpDuration.render(),
    gauge('api_http_requests_in_flight', 'Requests being answered.', inFlight),
    counter('process_cpu_seconds_total', 'User and system CPU time.', (cpu.user + cpu.system) / 1e6),
    gauge('process_resident_memory_bytes', 'Resident memory.', memory.rss),
    gauge('process_start_time_seconds', 'Start time since the epoch.', Math.round(startedAt)),
    gauge('nodejs_heap_used_bytes', 'V8 heap in use.', memory.heapUsed),
    gauge('nodejs_external_memory_bytes', 'Memory outside the V8 heap (buffers).', memory.external),
    gauge('nodejs_eventloop_delay_p50_seconds', 'Event-loop delay, median since the last scrape.', eventLoop.percentile(50) / 1e9),
    gauge('nodejs_eventloop_delay_p99_seconds', 'Event-loop delay, p99 since the last scrape.', eventLoop.percentile(99) / 1e9),
    gauge('nodejs_eventloop_delay_max_seconds', 'Event-loop delay, max since the last scrape.', eventLoop.max / 1e9),
    gauge('api_build_info', 'The running build.', 1, {
      version: process.env.npm_package_version || '0.1.0',
      commit: process.env.MORFA_BUILD_COMMIT || 'unknown',
      instance: process.env.MORFA_INSTANCE || process.env.PORT || 'api',
    }),
  ];
  eventLoop.reset();
  const fds = openFds();
  if (fds !== null) parts.push(gauge('process_open_fds', 'Open file descriptors.', fds));
  if (poolStatistics) {
    const pool = poolStatistics();
    parts.push(
      gauge('api_db_pool_total', 'PostgreSQL pool connections.', pool.total),
      gauge('api_db_pool_idle', 'Idle PostgreSQL pool connections.', pool.idle),
      gauge('api_db_pool_waiting', 'Queries waiting for a pool connection.', pool.waiting),
    );
  }
  return parts.join('\n') + '\n';
}

/** The private metrics listener: `GET /metrics` only. */
export function startMetricsServer(port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url?.startsWith('/metrics?'))) {
      res.writeHead(200, {'content-type': 'text/plain; version=0.0.4'});
      res.end(renderMetrics());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, host);
  server.unref();
  return server;
}
