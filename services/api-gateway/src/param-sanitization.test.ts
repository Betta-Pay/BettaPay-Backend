import test from 'tape';
import Fastify from 'fastify';
import { sanitizeParamString, sanitizeParamsValue, sanitizeInput } from './index.js';

// ── Unit Tests: sanitizeParamString & sanitizeParamsValue & sanitizeInput ───────

test('sanitizeParamString: removes null bytes, newlines, carriage returns, and control chars', (t) => {
  t.equal(sanitizeParamString('abc\x00\n\rtest'), 'abctest');
  t.equal(sanitizeParamString('\x01\x02query\x1F'), 'query');
  t.equal(sanitizeParamString('\x7Ftest\x7F'), 'test');
  t.end();
});

test('sanitizeParamString: preserves horizontal tabs (\\t)', (t) => {
  t.equal(sanitizeParamString('hello\tworld'), 'hello\tworld');
  t.equal(sanitizeParamString('\tpreserved\t'), '\tpreserved\t');
  t.end();
});

test('sanitizeParamString: leaves valid strings unchanged', (t) => {
  t.equal(sanitizeParamString('valid_merchant_id_123'), 'valid_merchant_id_123');
  t.equal(sanitizeParamString('search-query-123!@#$'), 'search-query-123!@#$');
  t.end();
});

test('sanitizeParamsValue: recursively sanitizes strings in objects and arrays', (t) => {
  const input = {
    param1: 'clean\x00data\n',
    nested: {
      field: 'nested\rval\x01',
      list: ['item1\x02', 'item2\tvalid', 123, true, null],
    },
    num: 42,
    bool: false,
  };

  const output = sanitizeParamsValue(input) as typeof input;

  t.equal(output.param1, 'cleandata');
  t.equal(output.nested.field, 'nestedval');
  t.equal(output.nested.list[0], 'item1');
  t.equal(output.nested.list[1], 'item2\tvalid');
  t.equal(output.nested.list[2], 123);
  t.equal(output.nested.list[3], true);
  t.equal(output.nested.list[4], null);
  t.equal(output.num, 42);
  t.equal(output.bool, false);
  t.end();
});

test('sanitizeInput: recursively handles deeply nested objects and arrays for body fields', (t) => {
  const input = {
    user: {
      name: ' Alice\x00\x01 ',
      metadata: {
        bio: 'Developer\n\x00',
        tags: ['tag1\r', 'tag2\x07', { key: 'val\x02' }],
      },
    },
  };

  const output = sanitizeInput(input) as typeof input;

  t.equal(output.user.name, 'Alice');
  t.equal(output.user.metadata.bio, 'Developer\n');
  t.equal(output.user.metadata.tags[0], 'tag1');
  t.equal(output.user.metadata.tags[1], 'tag2');
  t.equal((output.user.metadata.tags[2] as any).key, 'val');
  t.end();
});

// ── Fastify preHandler Hook Integration Test ──────────────────────────────────

test('preHandler hook: sanitizes query, params, headers, and body on incoming Fastify requests', async (t) => {
  const fastify = Fastify();

  fastify.addHook('preHandler', async (request) => {
    if (request.query && typeof request.query === 'object') {
      sanitizeParamsValue(request.query);
    }
    if (request.params && typeof request.params === 'object') {
      sanitizeParamsValue(request.params);
    }
    if (request.headers && typeof request.headers === 'object') {
      sanitizeParamsValue(request.headers);
    }
    if (request.body !== undefined) {
      request.body = sanitizeInput(request.body);
    }
  });

  let capturedQuery: any = null;
  let capturedParams: any = null;
  let capturedHeaders: any = null;
  let capturedBody: any = null;

  fastify.post('/test-route/:id', async (request) => {
    capturedQuery = request.query;
    capturedParams = request.params;
    capturedHeaders = request.headers;
    capturedBody = request.body;
    return { status: 'ok' };
  });

  const res = await fastify.inject({
    method: 'POST',
    url: `/test-route/${encodeURIComponent('id123\x00\n\r')}?status=${encodeURIComponent('pending\n\x00\r')}&tab=${encodeURIComponent('tag\tval')}`,
    headers: {
      'x-custom-header': 'header\x00val\x01',
    },
    payload: {
      description: '  test\x00body  ',
      items: [{ name: 'item\x02one' }],
    },
  });

  t.equal(res.statusCode, 200);
  t.equal(capturedParams.id, 'id123', 'Path param control characters stripped');
  t.equal(capturedQuery.status, 'pending', 'Query param control characters stripped');
  t.equal(capturedQuery.tab, 'tag\tval', 'Horizontal tab in query param preserved');
  t.equal(capturedHeaders['x-custom-header'], 'headerval', 'Header control characters stripped');
  t.equal(capturedBody.description, 'testbody', 'Nested body string sanitized and trimmed');
  t.equal(capturedBody.items[0].name, 'itemone', 'Nested array body object sanitized');
  await fastify.close();
  t.end();
});
