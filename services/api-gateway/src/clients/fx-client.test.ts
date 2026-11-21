import test from 'tape';
import { createFxClient } from './fx-client.js';
import { UpstreamReadTimeoutError } from '../upstream-fetch.js';

const BASE = 'http://fx.test:3002';

const quoteBody = {
  quoteId: 'quote_1',
  from: 'USDC',
  to: 'NGN',
  amount: '10.00',
  result: '15455.0000',
  rate: '1545.50000000',
  slippageBps: 50,
  slippageLimit: '0.0050',
  cachedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

test('getQuote calls fx-engine quote endpoint with auth and tracing headers', async (t) => {
  let calledUrl = '';
  let sentHeaders: Record<string, string> | undefined;
  const client = createFxClient({
    baseUrl: BASE,
    serviceToken: 'service-secret',
    fetchImpl: async (url, init) => {
      calledUrl = String(url);
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(quoteBody);
    },
  });

  const quote = await client.getQuote(
    { from: 'USDC', to: 'NGN', amount: '10.00' },
    { 'x-request-id': 'req-1', 'x-trace-id': 'trace-1' },
  );

  t.equal(quote?.quoteId, 'quote_1', 'returns the parsed quote');
  t.ok(calledUrl.includes('/api/quote'), 'queries the quote endpoint');
  t.ok(calledUrl.includes('from=USDC'), 'forwards source asset');
  t.ok(calledUrl.includes('to=NGN'), 'forwards target asset');
  t.ok(calledUrl.includes('amount=10.00'), 'forwards amount');
  t.equal(sentHeaders?.['x-service-token'], 'service-secret', 'sends service token');
  t.equal(sentHeaders?.['x-request-id'], 'req-1', 'forwards x-request-id');
  t.equal(sentHeaders?.['x-trace-id'], 'trace-1', 'forwards x-trace-id');
  t.end();
});

test('getQuote forwards merchant authorization when no service token is configured', async (t) => {
  let sentHeaders: Record<string, string> | undefined;
  const client = createFxClient({
    baseUrl: BASE,
    fetchImpl: async (_url, init) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(quoteBody);
    },
  });

  await client.getQuote(
    { from: 'USDC', to: 'EURT', amount: '5' },
    { authorization: 'Bearer merchant-jwt' },
  );

  t.equal(sentHeaders?.authorization, 'Bearer merchant-jwt', 'forwards merchant JWT fallback');
  t.notOk(sentHeaders?.['x-service-token'], 'does not invent a service token');
  t.end();
});

test('getQuote returns null on non-OK response', async (t) => {
  const client = createFxClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({}, false, 503),
  });

  const quote = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.equal(quote, null, 'non-OK response degrades to no quote');
  t.end();
});

test('getQuote throws UpstreamReadTimeoutError on timeout with no cached quote', async (t) => {
  const client = createFxClient({
    baseUrl: BASE,
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  });

  try {
    await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
    t.fail('expected UpstreamReadTimeoutError to be thrown');
  } catch (err) {
    t.ok(err instanceof UpstreamReadTimeoutError, 'timeout surfaces UpstreamReadTimeoutError');
  }
  t.end();
});

test('getQuote serves stale cached quote on timeout after a previous success', async (t) => {
  let shouldTimeout = false;
  const client = createFxClient({
    baseUrl: BASE,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      if (shouldTimeout) {
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return jsonResponse(quoteBody);
    },
  });

  // Prime the last-good cache with a successful response.
  const first = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.ok(first, 'first call returns a live quote');

  // Subsequent call times out but the stale cache entry is served.
  shouldTimeout = true;
  const cached = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.ok(cached, 'stale cached quote is served on timeout');
  t.equal(cached?.quoteId, 'quote_1', 'serves the previously cached quote');
  t.end();
});

test('different amount values never collide in lastGoodCache', async (t) => {
  let shouldTimeout = false;
  const client = createFxClient({
    baseUrl: BASE,
    timeoutMs: 10,
    fetchImpl: async (url, init) => {
      if (shouldTimeout) {
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      const urlStr = String(url);
      const amount = urlStr.includes('amount=10') ? '10' : '20';
      return jsonResponse({
        ...quoteBody,
        amount,
        quoteId: `quote_${amount}`,
      });
    },
  });

  // Prime cache for amount=10
  await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });

  // Now simulate timeout
  shouldTimeout = true;

  // Requesting amount=10 should return cached quote_10
  const cached10 = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.equal(cached10?.quoteId, 'quote_10', 'serves cached quote for amount=10');

  // Requesting amount=20 (never cached) should timeout and throw UpstreamReadTimeoutError, NOT return quote_10
  try {
    await client.getQuote({ from: 'USDC', to: 'NGN', amount: '20' });
    t.fail('expected timeout for uncached amount=20');
  } catch (err) {
    t.ok(err instanceof UpstreamReadTimeoutError, 'different amount does not collide with cached quote');
  }
  t.end();
});

test('lastGoodCache never grows beyond its configured max size (LRU eviction)', async (t) => {
  const MAX_SIZE = 3;
  const client = createFxClient({
    baseUrl: BASE,
    cacheMaxSize: MAX_SIZE,
    fetchImpl: async (url) => {
      const urlStr = String(url);
      const match = urlStr.match(/amount=(\d+)/);
      const amt = match ? match[1] : '1';
      return jsonResponse({ ...quoteBody, amount: amt, quoteId: `quote_${amt}` });
    },
  });

  // Insert 5 different entries
  for (let i = 1; i <= 5; i++) {
    await client.getQuote({ from: 'USDC', to: 'NGN', amount: String(i) });
  }

  t.equal(client._cacheSize?.(), MAX_SIZE, `cache size is capped at max size ${MAX_SIZE}`);
  t.end();
});

test('lastGoodCache evicts expired entries based on configured TTL', async (t) => {
  const TTL_MS = 20;
  let shouldTimeout = false;
  const client = createFxClient({
    baseUrl: BASE,
    cacheTtlMs: TTL_MS,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      if (shouldTimeout) {
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return jsonResponse(quoteBody);
    },
  });

  // Prime cache
  await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, TTL_MS + 10));

  shouldTimeout = true;
  try {
    await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
    t.fail('should have thrown because cache entry expired');
  } catch (err) {
    t.ok(err instanceof UpstreamReadTimeoutError, 'expired cache entry was evicted and not served');
  }
  t.end();
});

test('malformed upstream JSON or invalid payload triggers fallback/error and is never cached', async (t) => {
  let responseBody: any = { malformed: 'invalid structure missing required fields' };

  const client = createFxClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse(responseBody),
  });

  // 1. Invalid payload structure with no previous cache
  const result1 = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.equal(result1, null, 'malformed payload returns null and does not return invalid data');
  t.equal(client._cacheSize?.(), 0, 'invalid payload is never added to lastGoodCache');

  // 2. Prime cache with valid quote
  responseBody = quoteBody;
  const valid = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.ok(valid, 'valid quote cached successfully');
  t.equal(client._cacheSize?.(), 1, 'cache holds 1 entry');

  // 3. Upstream starts returning malformed payload -> should serve stale valid cached quote as fallback
  responseBody = { bad: 'data' };
  const fallback = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.ok(fallback, 'serves fallback stale cached quote on malformed upstream');
  t.equal(fallback?.quoteId, 'quote_1', 'fallback quote has valid quoteId');

  // 4. Non-JSON response (e.g. HTML 200 or parser throw)
  const clientBrokenJson = createFxClient({
    baseUrl: BASE,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as any),
  });

  const brokenJsonRes = await clientBrokenJson.getQuote({ from: 'USDC', to: 'NGN', amount: '10' });
  t.equal(brokenJsonRes, null, 'syntax error in res.json() returns null gracefully');
  t.end();
});
