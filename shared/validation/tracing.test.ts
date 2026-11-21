import test from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import {
  propagateTracingHeaders,
  extractTraceContext,
  registerTracing,
  REQUEST_ID_HEADER,
  TRACE_ID_HEADER,
  resolveTraceSampleRate,
  shouldSampleTrace,
  sanitizeTraceId,
  MAX_TRACE_ID_LENGTH,
} from './tracing.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('trace sampling resolves valid rates and falls back for invalid values', () => {
  assert.strictEqual(resolveTraceSampleRate('0.25'), 0.25);
  assert.strictEqual(resolveTraceSampleRate(2), 1);
  assert.strictEqual(resolveTraceSampleRate('invalid'), 1);
});

test('trace sampling uses the configured probability', () => {
  assert.strictEqual(shouldSampleTrace(0.25, () => 0.2), true);
  assert.strictEqual(shouldSampleTrace(0.25, () => 0.25), false);
  assert.strictEqual(shouldSampleTrace(0, () => 0), false);
  assert.strictEqual(shouldSampleTrace(1, () => 0.999), true);
});

test('extractTraceContext reuses incoming ids when present', () => {
  const ctx = extractTraceContext({
    [REQUEST_ID_HEADER]: 'req-123',
    [TRACE_ID_HEADER]: 'trace-abc',
  });
  assert.strictEqual(ctx.requestId, 'req-123');
  assert.strictEqual(ctx.traceId, 'trace-abc');
});

test('extractTraceContext generates separate ids when absent', () => {
  const ctx = extractTraceContext({});
  assert.match(ctx.requestId, UUID_RE);
  assert.match(ctx.traceId, UUID_RE);
  assert.notStrictEqual(ctx.requestId, ctx.traceId, 'request id and trace id are distinct');
});

test('extractTraceContext preserves valid ids up to the length cap (#1078)', () => {
  const maxLen = 'a'.repeat(MAX_TRACE_ID_LENGTH);
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const ctx = extractTraceContext({ [REQUEST_ID_HEADER]: maxLen, [TRACE_ID_HEADER]: uuid });
  assert.strictEqual(ctx.requestId, maxLen);
  assert.strictEqual(ctx.traceId, uuid);
});

test('extractTraceContext replaces oversized ids with a generated UUID (#1078)', () => {
  const ctx = extractTraceContext({
    [REQUEST_ID_HEADER]: 'r'.repeat(MAX_TRACE_ID_LENGTH + 1),
    [TRACE_ID_HEADER]: 't'.repeat(10_000),
  });
  assert.match(ctx.requestId, UUID_RE);
  assert.match(ctx.traceId, UUID_RE);
});

test('extractTraceContext replaces ids with control or unsafe characters (#1078)', () => {
  for (const bad of ['req-1\nINFO forged log line', 'trace\r\nx-evil: 1', 'a\u0000b', 'has space', 'tab\there', 'caf\u00e9', '\u007f']) {
    const ctx = extractTraceContext({ [REQUEST_ID_HEADER]: bad, [TRACE_ID_HEADER]: bad });
    assert.match(ctx.requestId, UUID_RE, `request id ${JSON.stringify(bad)} is replaced`);
    assert.match(ctx.traceId, UUID_RE, `trace id ${JSON.stringify(bad)} is replaced`);
  }
});

test('sanitizeTraceId uses the first value of a repeated header (#1078)', () => {
  assert.strictEqual(sanitizeTraceId(['trace-1', 'trace-2']), 'trace-1');
  assert.strictEqual(sanitizeTraceId(['x'.repeat(MAX_TRACE_ID_LENGTH + 1), 'trace-2']), undefined);
  assert.strictEqual(sanitizeTraceId(''), undefined);
  assert.strictEqual(sanitizeTraceId(undefined), undefined);
});

test('propagateTracingHeaders forwards both tracing headers and preserves others', () => {
  const out = propagateTracingHeaders(
    { [REQUEST_ID_HEADER]: 'req-1', [TRACE_ID_HEADER]: 'trace-1' },
    { 'x-service-token': 'secret' },
  );
  assert.strictEqual(out['x-service-token'], 'secret', 'existing outgoing headers preserved');
  assert.strictEqual(out[REQUEST_ID_HEADER], 'req-1');
  assert.strictEqual(out[TRACE_ID_HEADER], 'trace-1');
});

test('propagateTracingHeaders normalises array-valued headers to a single value', () => {
  const out = propagateTracingHeaders({ [REQUEST_ID_HEADER]: ['req-a', 'req-b'] });
  assert.strictEqual(out[REQUEST_ID_HEADER], 'req-a');
});

test('registerTracing echoes x-trace-id on the response and honours an incoming trace id', async () => {
  const app = Fastify({ logger: false });
  registerTracing(app);
  app.get('/', async () => ({ ok: true }));

  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { [TRACE_ID_HEADER]: 'trace-xyz' },
  });

  assert.strictEqual(res.headers[TRACE_ID_HEADER], 'trace-xyz', 'responds with the same trace id');
  await app.close();
});

test('registerTracing generates a trace id when none is supplied', async () => {
  const app = Fastify({ logger: false });
  registerTracing(app);
  app.get('/', async () => ({ ok: true }));

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.match(String(res.headers[TRACE_ID_HEADER]), UUID_RE, 'generated trace id is a uuid');
  await app.close();
});

test('registerTracing applies a per-route sampling override', async () => {
  const app = Fastify({ logger: false });
  registerTracing(app, { sampleRate: 0, random: () => 0.5 });
  app.get('/', { config: { traceSampleRate: 1 } }, async (request) => ({
    sampled: (request as FastifyRequest & { traceSampled: boolean }).traceSampled,
  }));

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.deepStrictEqual(res.json(), { sampled: true });
  await app.close();
});

test('registerTracing uses TRACE_SAMPLE_RATE from the environment', async () => {
  const previousRate = process.env.TRACE_SAMPLE_RATE;
  process.env.TRACE_SAMPLE_RATE = '0.25';
  const app = Fastify({ logger: false });
  registerTracing(app, { random: () => 0.5 });
  app.get('/', async (request) => ({
    sampled: (request as FastifyRequest & { traceSampled: boolean }).traceSampled,
  }));

  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.deepStrictEqual(res.json(), { sampled: false });
  } finally {
    if (previousRate === undefined) delete process.env.TRACE_SAMPLE_RATE;
    else process.env.TRACE_SAMPLE_RATE = previousRate;
    await app.close();
  }
});

test('registerTracing replaces an oversized incoming trace id with a UUID (#1078)', async () => {
  const app = Fastify({ logger: false });
  registerTracing(app);
  app.get('/', async (request) => ({ requestId: request.headers[REQUEST_ID_HEADER] }));

  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { [TRACE_ID_HEADER]: 'x'.repeat(MAX_TRACE_ID_LENGTH + 1) },
  });

  assert.match(String(res.headers[TRACE_ID_HEADER]), UUID_RE, 'oversized trace id is replaced');
  await app.close();
});
