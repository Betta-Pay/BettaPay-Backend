import test from 'tape';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';
import {
  resolveClientIp,
  extractMerchantId,
  resolveRateLimitIdentity,
  buildRateLimitKey,
  buildIpRateLimitKey,
  needsNestedIpLimit,
  rateLimitIdentityOf,
  type RateLimitRequestLike,
} from './rate-limit-key.js';

// Issue #559 — rate limits were keyed on the client IP alone, so every
// merchant behind one NAT shared a single bucket. Limits are now keyed per
// authenticated merchant, with the IP as the fallback for anonymous traffic
// and as a nested ceiling for authenticated traffic.

// These tests use intentionally failing payloads, and failed auth attempts
// feed the IP-reputation scorer (shared Redis, keyed by socket IP — 127.0.0.1
// under inject). Left at its default threshold it would 429 this suite's own
// address mid-run and mask the limiter under test, so it is disabled here;
// reputation blocking is covered by auth-security.test.ts.
process.env.AUTH_IP_THRESHOLD = '1000000';

// ── Client IP resolution ───────────────────────────────────────────────────

test('resolveClientIp prefers the leftmost X-Forwarded-For entry', (t) => {
  t.equal(resolveClientIp('203.0.113.7, 10.0.0.1', '10.0.0.1'), '203.0.113.7', 'proxy chain');
  t.equal(resolveClientIp(['203.0.113.7'], '10.0.0.1'), '203.0.113.7', 'header sent as an array');
  t.equal(resolveClientIp(undefined, '10.0.0.1'), '10.0.0.1', 'falls back to the socket address');
  t.equal(resolveClientIp('', '10.0.0.1'), '10.0.0.1', 'ignores an empty header');
  t.equal(resolveClientIp('  , 10.0.0.1', '10.0.0.1'), '10.0.0.1', 'ignores a blank first entry');
  t.end();
});

// ── Merchant extraction ────────────────────────────────────────────────────

test('extractMerchantId reads a merchant id from a verified bearer token', (t) => {
  const verify = (token: string) =>
    token === 'good' ? { merchantId: 'merchant-a' } : (() => { throw new Error('bad signature'); })();

  t.equal(extractMerchantId('Bearer good', verify), 'merchant-a', 'valid token');
  t.equal(extractMerchantId('bearer good', verify), 'merchant-a', 'scheme is case-insensitive');
  t.equal(extractMerchantId('  Bearer good  ', verify), 'merchant-a', 'surrounding whitespace');
  t.end();
});

test('extractMerchantId returns null for anything it cannot trust', (t) => {
  const verify = (token: string) => {
    if (token === 'good') return { merchantId: 'merchant-a' };
    if (token === 'no-merchant') return { ownerId: 'owner-a' };
    if (token === 'blank-merchant') return { merchantId: '' };
    if (token === 'numeric-merchant') return { merchantId: 42 };
    throw new Error('invalid token');
  };

  t.equal(extractMerchantId(undefined, verify), null, 'no Authorization header');
  t.equal(extractMerchantId('Basic abc', verify), null, 'non-bearer scheme');
  t.equal(extractMerchantId('Bearer', verify), null, 'bearer with no token');
  t.equal(extractMerchantId('Bearer forged', verify), null, 'signature verification fails');
  t.equal(extractMerchantId('Bearer no-merchant', verify), null, 'payload without a merchant id');
  t.equal(extractMerchantId('Bearer blank-merchant', verify), null, 'empty merchant id');
  t.equal(extractMerchantId('Bearer numeric-merchant', verify), null, 'non-string merchant id');
  t.end();
});

// ── Identity and key construction ──────────────────────────────────────────

test('an authenticated request is keyed by merchant, an anonymous one by IP', (t) => {
  const authenticated = resolveRateLimitIdentity({ merchantId: 'merchant-a', ip: '203.0.113.7' });
  const anonymous = resolveRateLimitIdentity({ merchantId: null, ip: '203.0.113.7' });

  t.equal(authenticated.dimension, 'merchant', 'authenticated requests use the merchant dimension');
  t.equal(buildRateLimitKey(authenticated), 'm:merchant-a', 'merchant key');
  t.equal(anonymous.dimension, 'ip', 'anonymous requests use the IP dimension');
  t.equal(buildRateLimitKey(anonymous), 'ip:203.0.113.7', 'IP key');
  t.end();
});

test('merchant and IP keys live in separate namespaces', (t) => {
  const merchantNamedLikeAnIp = resolveRateLimitIdentity({
    merchantId: '203.0.113.7',
    ip: '198.51.100.4',
  });
  const ipOnly = resolveRateLimitIdentity({ merchantId: null, ip: '203.0.113.7' });

  t.notEqual(
    buildRateLimitKey(merchantNamedLikeAnIp),
    buildRateLimitKey(ipOnly),
    'a merchant id that reads like an address cannot collide with that address',
  );
  t.end();
});

test('the nested IP ceiling applies to authenticated requests only', (t) => {
  const authenticated = resolveRateLimitIdentity({ merchantId: 'merchant-a', ip: '203.0.113.7' });
  const anonymous = resolveRateLimitIdentity({ merchantId: null, ip: '203.0.113.7' });

  t.equal(needsNestedIpLimit(authenticated), true, 'authenticated traffic is checked twice');
  t.equal(
    needsNestedIpLimit(anonymous),
    false,
    'anonymous traffic is already in the IP bucket and is not double-counted',
  );
  t.equal(buildIpRateLimitKey(authenticated), 'ip:203.0.113.7', 'ceiling key ignores the merchant');
  t.end();
});

test('rateLimitIdentityOf verifies a token once and memoizes the result', (t) => {
  let verifications = 0;
  const verify = (token: string) => {
    verifications += 1;
    if (token !== 'good') throw new Error('invalid token');
    return { merchantId: 'merchant-a' };
  };

  const request: RateLimitRequestLike = {
    headers: { authorization: 'Bearer good', 'x-forwarded-for': '203.0.113.7' },
    ip: '10.0.0.1',
  };

  const first = rateLimitIdentityOf(request, verify);
  const second = rateLimitIdentityOf(request, verify);

  t.equal(first.merchantId, 'merchant-a', 'merchant resolved from the token');
  t.equal(first.ip, '203.0.113.7', 'IP resolved through the proxy header');
  t.equal(second, first, 'the same identity object is reused');
  t.equal(verifications, 1, 'the token is verified once per request');
  t.end();
});

test('rateLimitIdentityOf prefers an already-authenticated merchant', (t) => {
  let verifications = 0;
  const verify = () => {
    verifications += 1;
    return { merchantId: 'from-token' };
  };

  const identity = rateLimitIdentityOf(
    {
      headers: { authorization: 'Bearer good' },
      ip: '10.0.0.1',
      user: { merchantId: 'from-auth' },
    },
    verify,
  );

  t.equal(identity.merchantId, 'from-auth', 'uses the verified merchant from route auth');
  t.equal(verifications, 0, 'skips re-verifying the token');
  t.end();
});

// ── Two-dimensional limiting under a shared NAT ────────────────────────────

const NAT_IP = '203.0.113.7';
const OTHER_IP = '198.51.100.4';

/**
 * A limiter wired exactly as the gateway wires it: the same key generator,
 * the same nested ceiling, at limits small enough to exhaust in a test.
 */
async function buildLimitedApp(opts: { max: number; ipMax: number }) {
  const app = Fastify({ logger: false });

  const tokens = new Map<string, { merchantId: string }>();
  const verify = (token: string) => {
    const payload = tokens.get(token);
    if (!payload) throw new Error('invalid token');
    return payload;
  };
  const identityFor = (request: any) => rateLimitIdentityOf(request, verify);

  // Awaited so the plugin's onRoute listener is installed before /ping is
  // declared and the limiter actually attaches to it.
  await app.register(rateLimit, {
    max: opts.max,
    timeWindow: '1 minute',
    keyGenerator: (request: any) => buildRateLimitKey(identityFor(request)),
  });

  let checkIpRateLimit: any;
  app.addHook('onRequest', async (request: any, reply: any) => {
    const identity = identityFor(request);
    if (!needsNestedIpLimit(identity)) return;

    checkIpRateLimit ??= app.createRateLimit({
      max: opts.ipMax,
      timeWindow: '1 minute',
      keyGenerator: (req: any) => buildIpRateLimitKey(identityFor(req)),
    });

    const result: any = await checkIpRateLimit(request);
    if (result.isExceeded === true) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
    }
  });

  app.get('/ping', async () => ({ ok: true }));

  return {
    app,
    /** Mint a token the fake verifier accepts. */
    tokenFor(merchantId: string) {
      const token = `token-${merchantId}`;
      tokens.set(token, { merchantId });
      return token;
    },
  };
}

function ping(app: any, opts: { ip: string; token?: string }) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.inject({ method: 'GET', url: '/ping', headers });
}

test('one noisy merchant cannot throttle another behind the same NAT', async (t) => {
  const { app, tokenFor } = await buildLimitedApp({ max: 3, ipMax: 1000 });
  await app.ready();

  const noisy = tokenFor('merchant-noisy');
  const quiet = tokenFor('merchant-quiet');

  const noisyStatuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    noisyStatuses.push((await ping(app, { ip: NAT_IP, token: noisy })).statusCode);
  }

  t.deepEqual(
    noisyStatuses,
    [200, 200, 200, 429],
    'the noisy merchant exhausts its own bucket',
  );

  const quietRes = await ping(app, { ip: NAT_IP, token: quiet });
  t.equal(
    quietRes.statusCode,
    200,
    'the quiet merchant on the same address is unaffected',
  );

  const quietRemaining = Number(quietRes.headers['x-ratelimit-remaining']);
  t.equal(quietRemaining, 2, 'the quiet merchant starts from a full bucket');

  await app.close();
  t.end();
});

test('anonymous traffic is limited per IP', async (t) => {
  const { app } = await buildLimitedApp({ max: 2, ipMax: 1000 });
  await app.ready();

  t.equal((await ping(app, { ip: NAT_IP })).statusCode, 200, 'first anonymous request');
  t.equal((await ping(app, { ip: NAT_IP })).statusCode, 200, 'second anonymous request');
  t.equal(
    (await ping(app, { ip: NAT_IP })).statusCode,
    429,
    'third anonymous request from the same address is limited',
  );
  t.equal(
    (await ping(app, { ip: OTHER_IP })).statusCode,
    200,
    'a different address has its own bucket',
  );

  await app.close();
  t.end();
});

test('an exhausted anonymous IP bucket does not limit authenticated merchants', async (t) => {
  const { app, tokenFor } = await buildLimitedApp({ max: 1, ipMax: 1000 });
  await app.ready();

  t.equal((await ping(app, { ip: NAT_IP })).statusCode, 200, 'anonymous request consumes the IP bucket');
  t.equal((await ping(app, { ip: NAT_IP })).statusCode, 429, 'the IP bucket is now exhausted');
  t.equal(
    (await ping(app, { ip: NAT_IP, token: tokenFor('merchant-a') })).statusCode,
    200,
    'an authenticated merchant on that address still gets its own allowance',
  );

  await app.close();
  t.end();
});

test('a forged token falls back to the IP dimension', async (t) => {
  const { app } = await buildLimitedApp({ max: 1, ipMax: 1000 });
  await app.ready();

  t.equal(
    (await ping(app, { ip: NAT_IP, token: 'forged' })).statusCode,
    200,
    'the first forged-token request is served',
  );
  t.equal(
    (await ping(app, { ip: NAT_IP, token: 'also-forged' })).statusCode,
    429,
    'forged tokens cannot mint fresh buckets — they share the address bucket',
  );

  await app.close();
  t.end();
});

test('the nested per-IP ceiling caps merchants sharing one address', async (t) => {
  const { app, tokenFor } = await buildLimitedApp({ max: 100, ipMax: 3 });
  await app.ready();

  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push(
      (await ping(app, { ip: NAT_IP, token: tokenFor(`merchant-${i}`) })).statusCode,
    );
  }

  t.deepEqual(
    statuses,
    [200, 200, 200, 429],
    'four distinct merchants on one address hit the nested ceiling of 3',
  );

  t.equal(
    (await ping(app, { ip: OTHER_IP, token: tokenFor('merchant-elsewhere') })).statusCode,
    200,
    'the ceiling is per address, not global',
  );

  await app.close();
  t.end();
});

// ── The real gateway ───────────────────────────────────────────────────────

test('the gateway keys its own limits per merchant', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();

  const tokenA = app.jwt.sign({ merchantId: 'merchant-a', ownerId: 'owner-a', jti: 'jti-a' });
  const tokenB = app.jwt.sign({ merchantId: 'merchant-b', ownerId: 'owner-b', jti: 'jti-b' });

  const call = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      headers: { 'x-forwarded-for': NAT_IP, authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
      payload: { address: 'GTESTADDRESS' },
    });

  const first = await call(tokenA);
  const second = await call(tokenA);
  const other = await call(tokenB);

  const limit = Number(first.headers['x-ratelimit-limit']);
  t.ok(Number.isFinite(limit), 'the route reports a limit');
  t.equal(
    Number(first.headers['x-ratelimit-remaining']),
    limit - 1,
    'merchant A: one request counted',
  );
  t.equal(
    Number(second.headers['x-ratelimit-remaining']),
    limit - 2,
    'merchant A: two requests counted',
  );
  t.equal(
    Number(other.headers['x-ratelimit-remaining']),
    limit - 1,
    'merchant B on the same address starts from a full bucket',
  );

  await app.close();
  t.end();
});

test('the gateway enforces its per-route limit per merchant', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();

  // /api/auth/wallet/verify carries a 30-per-minute route override.
  const ROUTE_MAX = 30;
  const call = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      headers: { 'x-forwarded-for': NAT_IP, authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
      payload: {},
    });

  const tokenA = app.jwt.sign({ merchantId: 'merchant-loud', ownerId: 'owner-a', jti: 'jti-a' });
  const tokenB = app.jwt.sign({ merchantId: 'merchant-calm', ownerId: 'owner-b', jti: 'jti-b' });

  let limitedWithinBudget = false;
  for (let i = 0; i < ROUTE_MAX; i += 1) {
    if ((await call(tokenA)).statusCode === 429) limitedWithinBudget = true;
  }
  t.equal(limitedWithinBudget, false, 'merchant A is served its full route allowance');

  const exceeded = await call(tokenA);
  t.equal(exceeded.statusCode, 429, 'merchant A is limited once its allowance is spent');
  t.equal(
    JSON.parse(exceeded.body).error.code,
    'RATE_LIMITED',
    'the gateway error envelope is used for 429s',
  );
  t.ok(exceeded.headers['retry-after'], 'Retry-After is set');

  const neighbour = await call(tokenB);
  t.notEqual(
    neighbour.statusCode,
    429,
    'merchant B on the same address is not throttled by merchant A',
  );

  await app.close();
  t.end();
});

test('the gateway keys anonymous traffic per IP', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();

  const call = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      headers: { 'x-forwarded-for': ip, 'x-csrf-check': '1' },
      payload: { address: 'GTESTADDRESS' },
    });

  const first = await call(NAT_IP);
  const second = await call(NAT_IP);
  const elsewhere = await call(OTHER_IP);

  const limit = Number(first.headers['x-ratelimit-limit']);
  t.equal(
    Number(second.headers['x-ratelimit-remaining']),
    limit - 2,
    'two anonymous requests from one address share a bucket',
  );
  t.equal(
    Number(elsewhere.headers['x-ratelimit-remaining']),
    limit - 1,
    'a different address has its own bucket',
  );

  await app.close();
  t.end();
});
