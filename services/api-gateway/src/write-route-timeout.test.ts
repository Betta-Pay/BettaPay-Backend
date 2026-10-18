/**
 * Tests for request-timeout handling on write routes (#886), run against the
 * real gateway app. Two probe routes (one slow, one fast) are registered on the
 * app so the timeout hook can be exercised on POSTs without depending on a
 * particular business route. Tests shrink GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs
 * temporarily, so nothing waits for the real 30s.
 */

import test from 'tape';
import { ErrorCodes } from '@bettapay/validation';
import { buildApp } from './index.js';
import { createMockPrisma, createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE } from './test-fixtures.js';
import {
  CONNECTION_TIMEOUT_MS,
  GATEWAY_TIMEOUT_CONFIG,
  REQUEST_TIMEOUT_MS,
} from './timeout-config.js';

const TIMEOUT_STATUS = 408;
const CLIENT_TIMEOUT_HEADER = 'x-client-timeout-ms';

// GATEWAY_TIMEOUT_CONFIG is `as const`; tests override it at runtime and restore it.
const mutableConfig = GATEWAY_TIMEOUT_CONFIG as unknown as { requestTimeoutMs: number };
const ORIGINAL_REQUEST_TIMEOUT_MS = mutableConfig.requestTimeoutMs;

async function withRequestTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  mutableConfig.requestTimeoutMs = ms;
  try {
    return await fn();
  } finally {
    mutableConfig.requestTimeoutMs = ORIGINAL_REQUEST_TIMEOUT_MS;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CSRF = { 'x-csrf-check': '1' };

async function buildProbeApp() {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  app.post('/probe/slow-write', async () => {
    await sleep(300);
    return { ok: true };
  });
  app.post('/probe/fast-write', async () => ({ ok: true }));
  await app.ready();
  return app;
}

// ── Real gateway app ─────────────────────────────────────────────────────────

test('real write route returns x-request-timeout-ms equal to the configured value', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { merchantId: MOCK_MERCHANT_ACTIVE.id, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'fast write route completes with its normal status');
  t.equal(
    res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader],
    String(GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs),
    'header equals configured requestTimeoutMs',
  );
  t.equal(GATEWAY_TIMEOUT_CONFIG.responseHeader, 'x-request-timeout-ms', 'header name is x-request-timeout-ms');

  await app.close();
  t.end();
});

test('timeout header is also present on a rejected write', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { 'x-csrf-check': '1' },
    payload: { merchantId: MOCK_MERCHANT_ACTIVE.id, amount: '10.00', asset: 'USDC' },
  });

  t.ok(res.statusCode >= 400, 'unauthenticated write is rejected');
  t.equal(
    res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader],
    String(GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs),
    'header still reflects the configured value',
  );

  await app.close();
  t.end();
});

test('the real write route header follows GATEWAY_TIMEOUT_CONFIG, not a hardcoded value', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const header = await withRequestTimeout(12_345, async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
      payload: { merchantId: MOCK_MERCHANT_ACTIVE.id, amount: '10.00', asset: 'USDC' },
    });
    return res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader];
  });

  t.equal(header, '12345', 'changing the config changes the header');
  await app.close();
  t.end();
});

test('Fastify requestTimeout and connectionTimeout come from the centralized config', async (t) => {
  const { app } = await createTestApp();
  t.equal((app.initialConfig as any).requestTimeout, ORIGINAL_REQUEST_TIMEOUT_MS, 'requestTimeout from config');
  t.equal(
    (app.initialConfig as any).connectionTimeout,
    GATEWAY_TIMEOUT_CONFIG.connectionTimeoutMs,
    'connectionTimeout from config',
  );
  await app.close();
  t.end();
});

test('the connection timeout constant is greater than the request timeout constant', (t) => {
  t.equal(REQUEST_TIMEOUT_MS, GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs, 'REQUEST_TIMEOUT_MS mirrors the config');
  t.equal(CONNECTION_TIMEOUT_MS, GATEWAY_TIMEOUT_CONFIG.connectionTimeoutMs, 'CONNECTION_TIMEOUT_MS mirrors the config');
  t.ok(CONNECTION_TIMEOUT_MS > REQUEST_TIMEOUT_MS, 'connection timeout exceeds request timeout');
  t.end();
});

// ── Enforcement ──────────────────────────────────────────────────────────────

const post = (app: any, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...CSRF, ...headers }, payload: {} });

test('a slow write route times out with the configured status code', async (t) => {
  const app = await buildProbeApp();

  const res = await withRequestTimeout(50, () => post(app, '/probe/slow-write'));

  t.equal(res.statusCode, TIMEOUT_STATUS, 'responds with the documented timeout status');
  t.equal(JSON.parse(res.body).error.code, ErrorCodes.REQUEST_TIMEOUT, 'error code is REQUEST_TIMEOUT');
  t.equal(res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader], '50', 'header reports the enforced timeout');

  await sleep(350); // let the abandoned handler finish before closing
  await app.close();
  t.end();
});

test('a fast write route is unaffected by the timeout', async (t) => {
  const app = await buildProbeApp();

  const res = await withRequestTimeout(50, () => post(app, '/probe/fast-write'));

  t.equal(res.statusCode, 200, 'returns its normal status');
  t.deepEqual(JSON.parse(res.body), { ok: true }, 'returns its normal body');
  t.equal(res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader], '50', 'header still reflects the configured value');

  await app.close();
  t.end();
});

test('changing GATEWAY_TIMEOUT_CONFIG changes the enforced timeout', async (t) => {
  const app = await buildProbeApp();

  const tight = await withRequestTimeout(50, () => post(app, '/probe/slow-write'));
  t.equal(tight.statusCode, TIMEOUT_STATUS, 'a 50ms limit times the 300ms write out');

  const loose = await withRequestTimeout(2_000, () => post(app, '/probe/slow-write'));
  t.equal(loose.statusCode, 200, 'a 2000ms limit lets the same write finish');

  await sleep(350);
  await app.close();
  t.end();
});

test('a shorter client timeout header is honored', async (t) => {
  const app = await buildProbeApp();

  const res = await withRequestTimeout(2_000, () =>
    post(app, '/probe/slow-write', { [CLIENT_TIMEOUT_HEADER]: '50' }),
  );

  t.equal(res.statusCode, TIMEOUT_STATUS, 'client-requested 50ms limit is enforced');
  t.equal(res.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader], '2000', 'header still reports the configured limit');

  await sleep(350);
  await app.close();
  t.end();
});

test('a client timeout header cannot extend the configured limit', async (t) => {
  const app = await buildProbeApp();

  const res = await withRequestTimeout(50, () =>
    post(app, '/probe/slow-write', { [CLIENT_TIMEOUT_HEADER]: '60000' }),
  );

  t.equal(res.statusCode, TIMEOUT_STATUS, 'configured 50ms limit still wins');

  await sleep(350);
  await app.close();
  t.end();
});

test('an invalid client timeout header is ignored', async (t) => {
  const app = await buildProbeApp();

  for (const bad of ['abc', '-5', '0', '1.5']) {
    const res = await withRequestTimeout(2_000, () =>
      post(app, '/probe/fast-write', { [CLIENT_TIMEOUT_HEADER]: bad }),
    );
    t.equal(res.statusCode, 200, `"${bad}" falls back to the configured limit`);
  }

  await app.close();
  t.end();
});

test('the request timeout config is restored after each override', (t) => {
  t.equal(mutableConfig.requestTimeoutMs, ORIGINAL_REQUEST_TIMEOUT_MS, 'config is back at its original value');
  t.end();
});
