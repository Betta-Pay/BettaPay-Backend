import test from 'tape';
import {
  createSettlementClient,
  SettlementEngineUnavailableError,
} from './settlement-client.js';

const BASE = 'http://settlement.test:3001';

function jsonResponse(body: unknown, status = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test('createSettlement posts payload to settlement-engine with auth and tracing headers', async (t) => {
  let calledUrl = '';
  let sentInit: RequestInit | undefined;
  const payload = { merchantId: 'merchant_1', amount: '10.00', asset: 'USDC' };

  const client = createSettlementClient({
    baseUrl: `${BASE}/`,
    serviceToken: 'service-secret',
    fetchImpl: async (url, init) => {
      calledUrl = String(url);
      sentInit = init;
      return jsonResponse({ id: 'set_1', status: 'pending' });
    },
  });

  const result = await client.createSettlement(payload, {
    'x-request-id': 'req-1',
    'x-trace-id': 'trace-1',
  });

  const headers = sentInit?.headers as Record<string, string>;
  t.equal(calledUrl, `${BASE}/api/settlements`, 'uses settlement-engine settlements endpoint');
  t.equal(sentInit?.method, 'POST', 'uses POST');
  t.equal(sentInit?.body, JSON.stringify(payload), 'serializes settlement payload');
  t.equal(headers['x-service-token'], 'service-secret', 'forwards inter-service token');
  t.equal(headers['x-request-id'], 'req-1', 'forwards x-request-id');
  t.equal(headers['x-trace-id'], 'trace-1', 'forwards x-trace-id');
  t.equal(result.status, 201, 'returns downstream status');
  t.same(result.body, { id: 'set_1', status: 'pending' }, 'returns downstream body');
  t.end();
});

test('createSettlement preserves non-2xx settlement-engine responses', async (t) => {
  const client = createSettlementClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({ error: { code: 'VALIDATION_ERROR' } }, 422),
  });

  const result = await client.createSettlement({ merchantId: 'merchant_1' });
  t.equal(result.status, 422, 'keeps downstream status');
  t.same(result.body, { error: { code: 'VALIDATION_ERROR' } }, 'keeps downstream body');
  t.end();
});

test('createSettlement throws SettlementEngineUnavailableError on timeout', async (t) => {
  const client = createSettlementClient({
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
    await client.createSettlement({ merchantId: 'merchant_1' });
    t.fail('expected timeout to throw');
  } catch (err) {
    t.ok(err instanceof SettlementEngineUnavailableError, 'throws typed unavailable error');
  }
  t.end();
});

test('createSettlement handles HTML 502 error responses safely without SyntaxError', async (t) => {
  const htmlBody = '<html><body>502 Bad Gateway</body></html>';
  const client = createSettlementClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      ({
        ok: false,
        status: 502,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
        text: async () => htmlBody,
      }) as unknown as Response,
  });

  const result = await client.createSettlement({ merchantId: 'merchant_1' });
  t.equal(result.status, 502, 'preserves 502 status code');
  t.ok(result.body && typeof result.body === 'object', 'produces a structured error body');
  t.equal((result.body as any)?.error?.code, 'UPSTREAM_ERROR', 'structured error code');
  t.equal((result.body as any)?.error?.message, htmlBody, 'includes error text in structured error');
  t.end();
});
