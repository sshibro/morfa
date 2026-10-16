// OTLP traces of the api's control-plane calls (docs/BACKEND.md §9; lane B5): `GET /api/design-files/:id/session` (TARGETS A2),
// the collab nodes' calls to `/internal/*`, and api's own calls to collab's `/internal/*` (pushes, replace, shadow). Spans go to the
// collector as OTLP/HTTP JSON batches (Tempo on the private network); nothing is added to node_modules. Unset, every hook returns
// at once.
//   OTEL_EXPORTER_OTLP_ENDPOINT          collector base URL (`/v1/traces` is appended); or
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   the full URL
//   OTEL_SERVICE_NAME                    service.name (morfa-api)
//   MORFA_TRACE_SAMPLE                   fraction of these calls exported, 0..1 (1: they are few)
//   MORFA_TRACE_SLOW_MS                  every call slower than this is exported (50)
import {randomBytes} from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';
import {routeLabel} from './metrics';

export type SpanKind = 'server' | 'client' | 'internal';
const KIND = {internal: 1, server: 2, client: 3} as const;
type Attribute = string | number | boolean;

export type FinishedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, Attribute>;
  error?: string;
};

export type TraceConfig = {url: string; service: string; instance: string; sample: number; slowMs: number};

/** The export settings, or null when no collector is configured. */
export function traceConfig(env: NodeJS.ProcessEnv = process.env): TraceConfig | null {
  const value = (name: string) => (env[name] || '').trim() || undefined;
  const url = value('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? (value('OTEL_EXPORTER_OTLP_ENDPOINT')?.replace(/\/+$/, '') ?? '');
  if (!url) return null;
  const sample = Number(value('MORFA_TRACE_SAMPLE') ?? 1);
  const slowMs = Number(value('MORFA_TRACE_SLOW_MS') ?? 50);
  return {
    url: value('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ? url : url + '/v1/traces',
    service: value('OTEL_SERVICE_NAME') ?? 'morfa-api',
    instance: value('MORFA_INSTANCE') ?? value('PORT') ?? 'api',
    sample: Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 1,
    slowMs: Number.isFinite(slowMs) && slowMs >= 0 ? slowMs : 50,
  };
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);

/** The OTLP/HTTP JSON body (ids as hex, 64-bit integers as strings: the protobuf JSON mapping). */
export function otlpJson(config: Pick<TraceConfig, 'service' | 'instance'>, spans: FinishedSpan[]): string {
  const attribute = (key: string, value: Attribute) => ({
    key,
    value: typeof value === 'number' ? (Number.isInteger(value) ? {intValue: String(value)} : {doubleValue: value}) : typeof value === 'boolean' ? {boolValue: value} : {stringValue: value},
  });
  return JSON.stringify({
    resourceSpans: [{
      resource: {attributes: [attribute('service.name', config.service), attribute('service.instance.id', config.instance)]},
      scopeSpans: [{
        scope: {name: 'morfa-api'},
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? {parentSpanId: span.parentSpanId} : {}),
          name: span.name,
          kind: KIND[span.kind],
          startTimeUnixNano: String(span.startNs),
          endTimeUnixNano: String(span.endNs),
          attributes: Object.entries(span.attributes).map(([key, value]) => attribute(key, value)),
          // STATUS_CODE_ERROR = 2.
          status: span.error ? {code: 2, message: span.error} : {},
        })),
      }],
    }],
  });
}

const QUEUE_LIMIT = 4096;
const BATCH_EVERY_MS = 2000;
let config: TraceConfig | null | undefined;
let queue: FinishedSpan[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
export const traceCounters = {exported: 0, dropped: 0};

function exporter(): TraceConfig | null {
  if (config === undefined) {
    config = traceConfig();
    if (config) {
      timer = setInterval(() => void flushSpans(), BATCH_EVERY_MS);
      timer.unref();
    }
  }
  return config;
}

/** Posts what is queued (also called at shutdown by server/index.ts). */
export async function flushSpans(): Promise<void> {
  const target = exporter();
  if (!target || !queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const response = await fetch(target.url, {method: 'POST', headers: {'content-type': 'application/json'}, body: otlpJson(target, batch), signal: AbortSignal.timeout(5000)});
    if (response.ok) traceCounters.exported += batch.length;
    else traceCounters.dropped += batch.length;
  } catch {
    traceCounters.dropped += batch.length;
  }
}

export type Span = {traceId: string; spanId: string; end(attributes?: Record<string, Attribute>, error?: string): void};
const NO_SPAN: Span = {traceId: '', spanId: '', end: () => {}};

/** Starts a span; it is exported at `end` when sampled or slower than MORFA_TRACE_SLOW_MS. */
export function startSpan(name: string, kind: SpanKind, attributes: Record<string, Attribute> = {}, parent?: {traceId: string; spanId: string}): Span {
  const target = exporter();
  if (!target) return NO_SPAN;
  const traceId = parent?.traceId || randomBytes(16).toString('hex'), spanId = randomBytes(8).toString('hex');
  const startNs = nowNs(), started = process.hrtime.bigint();
  const sampled = Math.random() < target.sample;
  return {
    traceId,
    spanId,
    end(extra = {}, error) {
      const elapsedNs = process.hrtime.bigint() - started;
      if (!sampled && Number(elapsedNs) / 1e6 < target.slowMs && !error) return;
      if (queue.length >= QUEUE_LIMIT) {
        traceCounters.dropped++;
        return;
      }
      queue.push({traceId, spanId, parentSpanId: parent?.spanId, name, kind, startNs, endNs: startNs + elapsedNs, attributes: {...attributes, ...extra}, error});
    },
  };
}

/** `traceparent` of an incoming request (W3C), if any. */
export function parentOf(header: string | undefined): {traceId: string; spanId: string} | undefined {
  const match = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec((header || '').trim());
  return match ? {traceId: match[1], spanId: match[2]} : undefined;
}

const TRACED = /^\/(?:internal\/|api\/design-files\/[^/]+\/session$)/;

/** Express middleware: a server span for `/session` and `/internal/*` (the control plane between api and collab). */
export function traceControlPlane(req: Request, res: Response, next: NextFunction) {
  if (!TRACED.test(req.path) || !exporter()) return next();
  const span = startSpan(`${req.method} ${req.path.startsWith('/internal/') ? req.path.replace(/\/[^/]*\d[^/]*/g, '/:id') : '/api/design-files/:id/session'}`, 'server', {'http.request.method': req.method}, parentOf(req.get('traceparent')));
  res.once('finish', () => {
    const status = res.statusCode;
    span.end({'http.route': routeLabel(req), 'http.response.status_code': status}, status >= 500 ? `status ${status}` : undefined);
  });
  next();
}
