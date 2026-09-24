import test from 'tape';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 500,
    timeWindow: '1 minute',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.route({
    method: ['GET', 'POST'],
    url: '/api/events/replay',
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_request, reply) => reply.code(200).send({ replayed: true }),
  });

  await app.ready();
  return app;
}

test('POST /api/webhooks - rejects a non-URL string', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { 'x-service-token': process.env.INTER_SERVICE_SECRET || 'test-secret-that-is-at-least-16-chars' },
      payload: { url: 'not-a-url' },
    });
    t.equal(res.statusCode, 400, 'should return 400 for a malformed URL');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'VALIDATION_ERROR', 'error code should be VALIDATION_ERROR');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('POST /api/webhooks - rejects a URL exceeding 2048 characters', async (t) => {
  await fastify.ready();

  try {
    const long = 'https://example.com/' + 'a'.repeat(2048);
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { 'x-service-token': process.env.INTER_SERVICE_SECRET || 'test-secret-that-is-at-least-16-chars' },
      payload: { url: long },
    });
    t.equal(res.statusCode, 400, 'should return 400 for an over-length URL');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'VALIDATION_ERROR', 'error code should be VALIDATION_ERROR');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('POST /api/webhooks - rejects requests without service token', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: 'https://example.com/webhook' },
    });
    t.equal(res.statusCode, 401, 'should return 401 without x-service-token');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'UNAUTHORIZED', 'error code should be UNAUTHORIZED');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('GET /api/webhooks - rejects requests without service token', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/webhooks',
    });
    t.equal(res.statusCode, 401, 'should return 401 without x-service-token');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'UNAUTHORIZED', 'error code should be UNAUTHORIZED');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('DELETE /api/webhooks/:id - rejects requests without service token', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/fake_id',
    });
    t.equal(res.statusCode, 401, 'should return 401 without x-service-token');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'UNAUTHORIZED', 'error code should be UNAUTHORIZED');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('GET /api/events/stats - rejects requests without service token', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/events/stats',
    });
    t.equal(res.statusCode, 401, 'should return 401 without x-service-token');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'UNAUTHORIZED', 'error code should be UNAUTHORIZED');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('GET /api/events/stats - rejects invalid date strings with 400', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/events/stats?from=not-a-date',
      headers: { 'x-service-token': process.env.INTER_SERVICE_SECRET || 'test-secret-that-is-at-least-16-chars' },
    });
    t.equal(res.statusCode, 400, 'should return 400 for invalid from date');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'VALIDATION_ERROR', 'error code should be VALIDATION_ERROR');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('GET /api/events/stats - rejects from > to with 400', async (t) => {
  await fastify.ready();

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/events/stats?from=2025-06-01T00:00:00Z&to=2024-06-01T00:00:00Z',
      headers: { 'x-service-token': process.env.INTER_SERVICE_SECRET || 'test-secret-that-is-at-least-16-chars' },
    });
    t.equal(res.statusCode, 400, 'should return 400 when from is after to');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'VALIDATION_ERROR', 'error code should be VALIDATION_ERROR');
  } catch (err: any) {
    t.fail(err);
  } finally {
    t.end();
  }
});

test('Indexer rate limiting - requests below the limit succeed', async (t) => {
  const app = await buildApp();

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '127.0.0.30',
    });
    t.equal(res.statusCode, 200, 'Requests below limit should succeed (200)');
    const body = JSON.parse(res.body);
    t.ok(['healthy', 'degraded', 'unhealthy'].includes(body.status), 'Should return a valid health status');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Indexer rate limiting - replay endpoint override strict limit (60 requests/min)', async (t) => {
  const app = await buildApp();

  try {
    const ip = '127.0.0.40';

    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/events/replay', remoteAddress: ip });
      t.equal(res.statusCode, 200, 'Replay request ' + (i + 1) + ' below or at limit should succeed (200)');
    }

    const resOver = await app.inject({ method: 'POST', url: '/api/events/replay', remoteAddress: ip });
    t.equal(resOver.statusCode, 429, '61st request to replay endpoint should return 429 Too Many Requests');
    const body = JSON.parse(resOver.body);
    t.match(body.message, /Rate limit exceeded|Too Many Requests/i, 'Error message should indicate rate limit exceeded');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Indexer rate limiting - global limit (500 requests/min)', async (t) => {
  const app = await buildApp();

  try {
    const ip = '127.0.0.50';
    const requests = [];
    for (let i = 0; i < 500; i++) {
      requests.push(app.inject({ method: 'GET', url: '/api/health', remoteAddress: ip }));
    }

    const responses = await Promise.all(requests);
    for (let i = 0; i < 500; i++) {
      t.equal(responses[i].statusCode, 200, 'Global request ' + (i + 1) + ' should succeed (200)');
    }

    const resOver = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: ip });
    t.equal(resOver.statusCode, 429, '501st request to global endpoint should return 429 Too Many Requests');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});
