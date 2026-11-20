import test from 'tape';
import { createIndexerClient, PAYMENT_COMPLETED_TYPE } from './indexer-client.js';

const BASE = 'http://indexer.test:3003';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// Builds an /api/events response body with one event per supplied `type`.
function eventsBody(...types: string[]) {
  return {
    events: types.map((type, i) => ({
      id: `evt_${i}`,
      contractId: 'C123',
      topics: [type],
      type,
      rawValue: 'AAAA',
      ledger: 100 + i,
      indexedAt: new Date().toISOString(),
    })),
    total: types.length,
    latestLedgerCursor: 200,
  };
}

test('getPaymentEvents returns only PaymentCompleted events on success', async (t) => {
  let calledUrl = '';
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async (url) => {
      calledUrl = String(url);
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE, 'SomethingElse', PAYMENT_COMPLETED_TYPE));
    },
  });

  const events = await client.getPaymentEvents('merchant_1');
  t.ok(Array.isArray(events), 'returns an array');
  t.equal(events!.length, 2, 'filters out non-PaymentCompleted topics');
  t.ok(calledUrl.includes('/api/events'), 'queries the indexer events endpoint');
  t.ok(calledUrl.includes('merchantId=merchant_1'), 'forwards merchantId');
  t.ok(calledUrl.includes(`type=${PAYMENT_COMPLETED_TYPE}`), 'forwards type filter');
  t.end();
});

test('getPaymentEvents accepts the paginated { data } envelope used by /api/events', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      jsonResponse({
        data: [
          {
            id: 'evt_paginated',
            contractId: 'C123',
            topics: [PAYMENT_COMPLETED_TYPE],
            type: PAYMENT_COMPLETED_TYPE,
            rawValue: 'AAAA',
            ledger: 101,
            indexedAt: new Date().toISOString(),
          },
        ],
        pagination: { page: 1, limit: 50, total: 1 },
      }),
  });

  const events = await client.getPaymentEvents('merchant_1');
  t.equal(events?.length, 1, 'parses events from the paginated data envelope');
  t.equal(events?.[0]?.id, 'evt_paginated', 'returns the indexed event');

  t.end();
});

test('getPaymentEvents sends the x-service-token header when a serviceToken is set (#117)', async (t) => {
  let sentHeaders: Record<string, string> | undefined;
  const client = createIndexerClient({
    baseUrl: BASE,
    serviceToken: 'super-secret-token',
    fetchImpl: async (_url, init) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE));
    },
  });
  await client.getPaymentEvents('merchant_1');
  t.equal(sentHeaders?.['x-service-token'], 'super-secret-token', 'forwards the inter-service token');
  t.end();
});

test('getPaymentEvents omits the service-token header when no token is configured', async (t) => {
  let sentHeaders: Record<string, string> | undefined;
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async (_url, init) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE));
    },
  });
  await client.getPaymentEvents('merchant_1');
  t.notOk(sentHeaders?.['x-service-token'], 'no token header when unset');
  t.end();
});

test('getPaymentEvents forwards incoming tracing headers downstream (#118)', async (t) => {
  let sentHeaders: Record<string, string> | undefined;
  const client = createIndexerClient({
    baseUrl: BASE,
    serviceToken: 'tok',
    fetchImpl: async (_url, init) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE));
    },
  });
  await client.getPaymentEvents('merchant_1', {
    'x-request-id': 'req-77',
    'x-trace-id': 'trace-88',
  });
  t.equal(sentHeaders?.['x-request-id'], 'req-77', 'forwards x-request-id');
  t.equal(sentHeaders?.['x-trace-id'], 'trace-88', 'forwards x-trace-id');
  t.equal(sentHeaders?.['x-service-token'], 'tok', 'still sends service token alongside tracing');
  t.end();
});

test('getPaymentEvents returns [] when indexer has no matching events', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse(eventsBody('OtherEvent')),
  });
  const events = await client.getPaymentEvents('merchant_1');
  t.same(events, [], 'empty array, not null, when reachable but nothing matches');
  t.end();
});

test('getPaymentEvents returns null on non-OK response (graceful degradation)', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({}, false, 503),
  });
  const events = await client.getPaymentEvents('merchant_1');
  t.equal(events, null, 'null signals indexer unavailable');
  t.end();
});

test('getPaymentEvents returns null on network error', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const events = await client.getPaymentEvents('merchant_1');
  t.equal(events, null, 'network failure degrades to null');
  t.end();
});

test('getPaymentEvents returns null when the request times out', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    timeoutMs: 10,
    // Hangs until the AbortController fires, then rejects like fetch does.
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  });
  const events = await client.getPaymentEvents('merchant_1');
  t.equal(events, null, 'timeout aborts and degrades to null');
  t.end();
});

test('getPaymentEvents returns null on malformed JSON body', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json');
        },
      }) as unknown as Response,
  });
  const events = await client.getPaymentEvents('merchant_1');
  t.equal(events, null, 'parse failure degrades to null');
  t.end();
});

test('getPaymentEvents forwards pagination query params (page and limit) to indexer', async (t) => {
  let calledUrl = '';
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async (url) => {
      calledUrl = String(url);
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE));
    },
  });

  await client.getPaymentEvents('merchant_1', { page: 3, limit: 25 });
  t.ok(calledUrl.includes('page=3'), 'forwards page parameter');
  t.ok(calledUrl.includes('limit=25'), 'forwards limit parameter');
  t.ok(calledUrl.includes('merchantId=merchant_1'), 'still forwards merchantId');

  // Also test with incomingHeaders and pagination params as 3rd arg
  calledUrl = '';
  await client.getPaymentEvents('merchant_1', { 'x-request-id': 'req-99' }, { page: 4, limit: 10 });
  t.ok(calledUrl.includes('page=4'), 'forwards page parameter when passed with headers');
  t.ok(calledUrl.includes('limit=10'), 'forwards limit parameter when passed with headers');
  t.end();
});

test('getPaymentEvents forwards cursor parameter to indexer', async (t) => {
  let calledUrl = '';
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async (url) => {
      calledUrl = String(url);
      return jsonResponse(eventsBody(PAYMENT_COMPLETED_TYPE));
    },
  });

  await client.getPaymentEvents('merchant_1', { cursor: 'cursor_12345' });
  t.ok(calledUrl.includes('cursor=cursor_12345'), 'forwards cursor parameter');
  t.end();
});

test('testWebhook preserves 400 error response from upstream', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      jsonResponse(
        { error: { code: 'VALIDATION_ERROR', message: 'Target host is not allowed' } },
        false,
        400,
      ),
  });

  const result = await client.testWebhook('wh_1', 'mch_1');
  t.ok(result, 'returns result instead of null');
  t.equal(result?.success, false, 'marked as failure');
  t.equal(result?.statusCode, 400, 'preserves 400 status code');
  t.equal(result?.error, 'Target host is not allowed', 'preserves upstream error message');
  t.end();
});

test('testWebhook preserves 403 error response from upstream', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      jsonResponse(
        { error: { code: 'FORBIDDEN', message: 'Cannot test webhook owned by another merchant' } },
        false,
        403,
      ),
  });

  const result = await client.testWebhook('wh_1', 'mch_1');
  t.ok(result, 'returns result instead of null');
  t.equal(result?.success, false, 'marked as failure');
  t.equal(result?.statusCode, 403, 'preserves 403 status code');
  t.equal(result?.error, 'Cannot test webhook owned by another merchant', 'preserves upstream error message');
  t.end();
});

test('testWebhook degrades to null on 500 or upstream failure', async (t) => {
  const client = createIndexerClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({}, false, 500),
  });

  const result = await client.testWebhook('wh_1', 'mch_1');
  t.equal(result, null, 'returns null on 500 upstream server error');
  t.end();
});
