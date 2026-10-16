import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {Histogram, httpMetrics, renderMetrics, routeLabel} from '../server/observability/metrics';
import {flushSpans, otlpJson, parentOf, startSpan, traceConfig} from '../server/observability/tracing';

// Lane B5: the api's Prometheus metrics and OTLP spans (server/observability), and api's reaction to a draining collab node
// (server/design/collab/leases.ts). No database: the lease module's pool is lazy and never connects here.

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const bodyOf = (req: IncomingMessage) =>
  new Promise<string>(resolve => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => resolve(text));
  });

test('route labels: mount paths lose their ids, patterns stay, unmatched requests share one label', () => {
  assert.equal(routeLabel({baseUrl: '/api/design-files', route: {path: '/:id/session'}} as never), '/api/design-files/:id/session');
  assert.equal(routeLabel({baseUrl: '/api/design-files', route: {path: '/'}} as never), '/api/design-files');
  assert.equal(
    routeLabel({baseUrl: '/api/design-files/0b5f6c1e-58c9-4b1e-9d3e-1f2a3b4c5d6e/comments', route: {path: '/'}} as never),
    '/api/design-files/:id/comments',
  );
  assert.equal(routeLabel({baseUrl: '', route: {path: '/api/health'}} as never), '/api/health');
  assert.equal(routeLabel({baseUrl: '/api/design-files', route: undefined} as never), 'unmatched');
});

test('histogram: cumulative buckets, +Inf, sum and count per label set, label values escaped', () => {
  const histogram = new Histogram('t_seconds', 'test', [0.01, 0.1]);
  histogram.observe({route: '/a'}, 0.005);
  histogram.observe({route: '/a'}, 0.05);
  histogram.observe({route: 'say "hi"'}, 1);
  const text = histogram.render();
  assert.match(text, /^# TYPE t_seconds histogram$/m);
  assert.match(text, /^t_seconds_bucket\{route="\/a",le="0.01"\} 1$/m);
  assert.match(text, /^t_seconds_bucket\{route="\/a",le="0.1"\} 2$/m);
  assert.match(text, /^t_seconds_bucket\{route="\/a",le="\+Inf"\} 2$/m);
  assert.match(text, /^t_seconds_count\{route="\/a"\} 2$/m);
  assert.match(text, /^t_seconds_bucket\{route="say \\"hi\\"",le="0.1"\} 0$/m);
});

test('http metrics: a request through express is timed under its route pattern (A1, A2, A5 panels read these)', async () => {
  const app = express();
  app.use(httpMetrics);
  const files = express.Router();
  files.get('/:id/session', (_req, res) => void res.json({ok: true}));
  app.use('/api/design-files', files);
  const server = createServer(app);
  const port = await listen(server);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/design-files/f-123/session`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nothing/here`)).status, 404);
  } finally {
    await close(server);
  }
  const text = renderMetrics();
  assert.match(text, /api_http_request_duration_seconds_count\{method="GET",route="\/api\/design-files\/:id\/session",status="2xx"\} 1/);
  assert.match(text, /api_http_request_duration_seconds_count\{method="GET",route="unmatched",status="4xx"\} 1/);
  assert.match(text, /^process_cpu_seconds_total \d/m);
  assert.match(text, /^nodejs_eventloop_delay_p99_seconds /m);
});

test('trace config: the OTEL variables, defaults, and nothing without a collector', () => {
  assert.equal(traceConfig({}), null);
  assert.deepEqual(traceConfig({OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/', PORT: '3401'}), {
    url: 'http://127.0.0.1:4318/v1/traces', service: 'morfa-api', instance: '3401', sample: 1, slowMs: 50,
  });
  const full = traceConfig({OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://tempo:4318/v1/traces', MORFA_TRACE_SAMPLE: '7', OTEL_SERVICE_NAME: 'x'});
  assert.equal(full?.url, 'http://tempo:4318/v1/traces');
  assert.equal(full?.sample, 1, 'a fraction above 1 falls back to every call');
  assert.equal(full?.service, 'x');
  assert.deepEqual(parentOf('00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'), {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)});
  assert.equal(parentOf('garbage'), undefined);
});

test('OTLP JSON: hex ids, nanosecond strings, typed attributes, error status', () => {
  const body = JSON.parse(otlpJson({service: 'morfa-api', instance: 'a'}, [{
    traceId: 'ab'.repeat(16), spanId: '01'.repeat(8), parentSpanId: '02'.repeat(8), name: 'GET /x', kind: 'server',
    startNs: 1_000_000_000n, endNs: 2_000_000_123n, attributes: {route: '/x', status: 200, ok: true, ratio: 0.5}, error: 'boom',
  }]));
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(body.resourceSpans[0].resource.attributes[0].value.stringValue, 'morfa-api');
  assert.equal(span.kind, 2);
  assert.equal(span.endTimeUnixNano, '2000000123');
  assert.equal(span.parentSpanId, '02'.repeat(8));
  assert.deepEqual(span.attributes.map((a: {value: unknown}) => a.value), [{stringValue: '/x'}, {intValue: '200'}, {boolValue: true}, {doubleValue: 0.5}]);
  assert.deepEqual(span.status, {code: 2, message: 'boom'});
});

test('spans reach the collector as one JSON batch', async () => {
  const received: string[] = [];
  const collector = createServer(async (req, res) => {
    received.push(`${req.method} ${req.url} ${req.headers['content-type']} ${await bodyOf(req)}`);
    res.writeHead(200).end('{}');
  });
  const port = await listen(collector);
  const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    const span = startSpan('GET /api/design-files/:id/session', 'server', {'http.request.method': 'GET'});
    span.end({'http.response.status_code': 200});
    await flushSpans();
  } finally {
    if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    await close(collector);
  }
  assert.equal(received.length, 1);
  assert.match(received[0], /^POST \/v1\/traces application\/json /);
  const body = JSON.parse(received[0].split(' ').slice(3).join(' '));
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].name, 'GET /api/design-files/:id/session');
});

test('a draining collab node is marked unhealthy at once and keeps its leases', async () => {
  process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
  const {checkCollabNode} = await import('../server/design/collab/leases');
  const {unhealthyNodes, nodeHealthy} = await import('../server/design/collab/nodes');
  let draining = true;
  const fake = createServer((_req, res) => {
    res.writeHead(draining ? 503 : 200, {'content-type': 'application/json'}).end(JSON.stringify({ok: !draining, draining}));
  });
  const port = await listen(fake);
  const node = {name: 'b5-test-node', internal: `http://127.0.0.1:${port}`, public: `ws://127.0.0.1:${port}`};
  try {
    // One answer is enough (a dead node needs three failures, then its leases are expired in the database: not here).
    await checkCollabNode(node);
    assert.ok(unhealthyNodes().has(node.name));
    draining = false;
    await checkCollabNode(node);
    assert.ok(!unhealthyNodes().has(node.name), 'healthy again after the restart');
  } finally {
    nodeHealthy(node.name);
    await close(fake);
  }
});

test('dashboards: one panel per TARGETS row id, the target and ceiling drawn, and the committed files are current', async () => {
  const {outputs, targetsDashboard, LIVE} = await import('../scripts/deploy/dashboards');
  const {loadTargets} = await import('../scripts/bench/lib/targets');
  const {readFileSync} = await import('node:fs');
  const targets = loadTargets();
  const dashboard = targetsDashboard(targets as never) as {panels: {type: string; title: string; targets?: {expr: string; legendFormat: string}[]}[]};
  const panels = dashboard.panels.filter(panel => panel.type !== 'row');
  assert.deepEqual(panels.map(panel => panel.title.split(' — ')[0]), targets.rows.map(row => row.id));
  const m1 = panels.find(panel => panel.title.startsWith('M1 '))!;
  assert.ok(m1.targets!.some(target => target.expr === 'vector(5)' && target.legendFormat === 'target p99'));
  assert.ok(m1.targets!.some(target => target.expr === 'vector(20)' && target.legendFormat === 'ceiling p99'));
  assert.ok(m1.targets!.some(target => target.expr === 'morfa_target_live{row="M1",metric="p99"}'));
  for (const [row, metrics] of Object.entries(LIVE)) {
    const spec = targets.rows.find(candidate => candidate.id === row);
    assert.ok(spec, `LIVE names an unknown row ${row}`);
    for (const key of Object.keys(metrics)) assert.ok(spec.metrics.some(metric => metric.key === key), `${row}.${key}`);
  }
  for (const [file, text] of Object.entries(outputs())) assert.equal(readFileSync(file, 'utf8'), text, `${file} is stale: npx tsx scripts/deploy/dashboards.ts`);
});

test('targets-prom: a closing run becomes textfile gauges by row, metric, profile and hash', async () => {
  const {targetsExposition} = await import('../scripts/deploy/targets-prom');
  const {loadTargets} = await import('../scripts/bench/lib/targets');
  const text = targetsExposition(loadTargets(), {
    M1: {id: 'M1', values: {p50: 0.4, p95: 1.5, p99: 3}},
    M9: {id: 'M9', pass: true},
    W2: {id: 'W2', na: 'needs B3'},
  }, 'cores4', 'abc1234');
  assert.match(text, /^morfa_target_actual\{row="M1",metric="p99",profile="cores4",hash="abc1234"\} 3$/m);
  assert.match(text, /^morfa_target_pass\{row="M9",profile="cores4",hash="abc1234"\} 1$/m);
  assert.match(text, /^morfa_target_state\{row="M1",state="green",profile="cores4",hash="abc1234"\} 1$/m);
  assert.match(text, /^morfa_target_state\{row="W2",state="n.a.",profile="cores4",hash="abc1234"\} 1$/m);
});
