import test from 'tape';
import { createTestApp } from './test-utils.js';

test('GET /api/docs/json returns valid OpenAPI 3 document', async (t) => {
  const { app } = await createTestApp();

  const res = await app.inject({
    method: 'GET',
    url: '/api/docs/json',
  });

  t.equal(res.statusCode, 200, 'returns 200 status code');
  const body = JSON.parse(res.body);

  t.ok(body.openapi && body.openapi.startsWith('3.'), 'openapi version is 3.x');
  t.equal(body.info.title, 'BettaPay API', 'title is BettaPay API');
  t.equal(body.info.version, '0.1.0', 'version matches service version');
  t.ok(Array.isArray(body.servers), 'servers is an array');
  t.equal(body.servers[0]?.url, 'http://localhost:3000', 'servers contains http://localhost:3000');
  t.ok(body.paths && typeof body.paths === 'object', 'paths object exists');

  await app.close();
  t.end();
});

test('OpenAPI documents the payments listing bounds and includeDeleted flags', async (t) => {
  const { app } = await createTestApp();

  const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  const params = body.paths?.['/api/payments']?.get?.parameters ?? [];
  const byName = Object.fromEntries(params.map((p: any) => [p.name, p]));

  t.ok(byName.limit, 'limit parameter is documented');
  t.equal(byName.limit.schema.default, 50, 'default page size is documented');
  t.equal(byName.limit.schema.maximum, 100, 'maximum page size is documented');
  t.ok(byName.includeDeleted, 'includeDeleted is documented');
  t.equal(byName.includeDeleted.schema.default, false, 'includeDeleted defaults to false');
  t.match(
    byName.includeDeleted.description,
    /admin|service-auth/i,
    'includeDeleted documents the admin authorization',
  );

  await app.close();
  t.end();
});
