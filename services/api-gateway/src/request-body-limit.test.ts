import test from 'tape';
import zlib from 'zlib';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt, createMockSettlementClient, createMockFxClient, createMockIndexerClient } from './test-utils.js';

const BODY_LIMIT = 1_048_576;

function gzipJson(payload: unknown): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
}

// Builds a gzip payload whose decompressed JSON body is exactly `targetBytes` long.
function gzipJsonOfExactSize(targetBytes: number): Buffer {
  const overhead = JSON.stringify({ address: 'GTESTADDRESS', padding: '' }).length;
  const json = JSON.stringify({ address: 'GTESTADDRESS', padding: 'a'.repeat(targetBytes - overhead) });
  return zlib.gzipSync(Buffer.from(json));
}

test('Fastify uses the configured request body size limits on gateway app', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  t.equal(app.initialConfig.bodyLimit, 1_048_576, 'bodyLimit is configured to exactly 1,048,576 bytes (1MB)');
  await app.close();
  t.end();
});

test('payload above limit is rejected with HTTP 413 on gateway app', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = 'a'.repeat(BODY_LIMIT + 1);

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/token',
    headers: {
      'content-type': 'application/json',
    },
    payload,
  });

  t.equal(response.statusCode, 413, 'returns 413 Payload Too Large');
  const body = JSON.parse(response.body);
  t.equal(body.error.code, 'FST_ERR_CTP_BODY_TOO_LARGE', 'reports the body-too-large error code');
  t.match(body.error.message, /too large/i, 'message mentions the oversized body');

  await app.close();
  t.end();
});

test('gzip body decompressing to ~500KB is accepted', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = gzipJson({ address: 'GTESTADDRESS', padding: 'a'.repeat(500_000) });

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload,
  });

  t.ok([200, 201].includes(response.statusCode), `returns 2xx, got ${response.statusCode}`);

  await app.close();
  t.end();
});

test('gzip body decompressing to ~1.5MB is rejected with 413', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = gzipJson({ address: 'GTESTADDRESS', padding: 'a'.repeat(1_500_000) });

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload,
  });

  t.equal(response.statusCode, 413, 'returns 413 Payload Too Large');

  await app.close();
  t.end();
});

test('invalid gzip stream is rejected with 400', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = Buffer.from('this is not a valid gzip stream');

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload,
  });

  t.equal(response.statusCode, 400, 'returns 400 for an invalid gzip stream');

  await app.close();
  t.end();
});

test('gzip body decompressing to exactly 1 MB is accepted', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = gzipJsonOfExactSize(BODY_LIMIT);

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload,
  });

  t.ok([200, 201].includes(response.statusCode), `returns 2xx, got ${response.statusCode}`);

  await app.close();
  t.end();
});

test('gzip body decompressing to 1 MB + 1 byte is rejected with 413', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = gzipJsonOfExactSize(BODY_LIMIT + 1);

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload,
  });

  t.equal(response.statusCode, 413, 'returns 413 Payload Too Large');

  await app.close();
  t.end();
});

test('Content-Encoding: identity skips decompression', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const payload = JSON.stringify({ address: 'GTESTADDRESS' });

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'identity',
    },
    payload,
  });

  t.ok([200, 201].includes(response.statusCode), `returns 2xx, got ${response.statusCode}`);

  await app.close();
  t.end();
});

const MUTATING_ROUTES: { method: string; url: string; description: string; auth?: boolean; preValidation?: string }[] = [
  { method: 'POST', url: '/api/merchants', description: 'merchants', auth: true },
  { method: 'POST', url: '/api/payments', description: 'payments', auth: true },
  { method: 'POST', url: '/api/settlements', description: 'settlements', auth: true },
  { method: 'POST', url: '/api/admin/assets', description: 'admin assets', auth: false, preValidation: 'serviceAuth' },
  { method: 'PATCH', url: '/api/merchants/m1/settings', description: 'merchant settings', auth: true },
];

for (const route of MUTATING_ROUTES) {
  test(`413 on oversized body for ${route.method} ${route.description}`, async (t) => {
    const prisma = createMockPrisma() as any;
    const app = buildApp({
      prisma,
      logger: false,
      settlementClient: createMockSettlementClient() as any,
      fxClient: createMockFxClient() as any,
      indexerClient: createMockIndexerClient() as any,
    });
    await app.ready();

    const token = generateTestJwt(app);
    const payload = 'a'.repeat(BODY_LIMIT + 1);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (route.auth) {
      headers['authorization'] = `Bearer ${token}`;
    }

    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers,
      payload,
    });

    t.equal(response.statusCode, 413, `returns 413 Payload Too Large for ${route.method} ${route.url}`);

    await app.close();
    t.end();
  });
}
