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
