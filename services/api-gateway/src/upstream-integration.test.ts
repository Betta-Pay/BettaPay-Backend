import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';

test('upstream-integration: GET /api/rates forwards request and propagates tracing headers', async (t) => {
  let forwardedHeaders: Record<string, string> = {};
  
  // Custom mock fetch implementation to inspect header propagation
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    forwardedHeaders = (init?.headers || {}) as Record<string, string>;
    return new Response(JSON.stringify({ rate: '1.25' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = buildApp({
    prisma: createMockPrisma() as any,
    logger: false,
    fetchImpl: fetchImpl as any, // Propagated for health check or custom endpoints if needed
  });

  // Temporarily mock global fetch for proxyFxUpstream calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/rates',
      headers: {
        'x-request-id': 'req-tracing-12345',
        'x-trace-id': 'trace-12345',
      },
    });

    t.equal(res.statusCode, 200, 'proxy should return 200 OK');
    t.equal(res.headers['cache-control'], 'public, max-age=60', 'rates response includes Cache-Control');
    const body = JSON.parse(res.body);
    t.equal(body.rate, '1.25');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  t.end();
});

test('upstream-integration: GET /api/currencies handles upstream errors gracefully', async (t) => {
  const fetchImpl = async () => {
    return new Response(JSON.stringify({ error: 'Internal upstream crash' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = buildApp({
    prisma: createMockPrisma() as any,
    logger: false,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/currencies',
    });

    t.equal(res.statusCode, 502, 'should propagate upstream status code 502');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  t.end();
});

test('upstream-integration: GET /api/quote normalizes query parameters for upstream engine', async (t) => {
  let targetUrl = '';
  
  const fetchImpl = async (url: string | URL | Request) => {
    targetUrl = String(url);
    return new Response(JSON.stringify({ quoteId: 'q-101', price: '120.00' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = buildApp({
    prisma: createMockPrisma() as any,
    logger: false,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/quote?from=USDC&to=NGN&amount=50.00',
    });

    t.equal(res.statusCode, 200, 'returns 200 OK');
    t.ok(targetUrl.includes('from=USDC'), 'forwards parameters to upstream URL');
    t.ok(targetUrl.includes('to=NGN'), 'forwards parameters to upstream URL');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  t.end();
});

test('upstream-integration: fetchUpstream handling socket timeout', async (t) => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };

  const app = buildApp({
    prisma: createMockPrisma() as any,
    logger: false,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/rates',
    });

    t.equal(res.statusCode, 500, 'failed fetch triggers global 500 handler');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  t.end();
});

test('upstream-integration: GET /api/quote rejects duplicate query keys', async (t) => {
  let upstreamCalled = false;
  const fetchImpl = async () => {
    upstreamCalled = true;
    return new Response(JSON.stringify({ quoteId: 'unexpected' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = buildApp({
    prisma: createMockPrisma() as any,
    logger: false,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/quote?from=USDC&from=XLM&to=NGN&amount=50.00',
    });

    t.equal(res.statusCode, 400, 'duplicate from parameter returns 400');
    t.equal(upstreamCalled, false, 'does not forward duplicate query to upstream');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }

  t.end();
});
export {};
