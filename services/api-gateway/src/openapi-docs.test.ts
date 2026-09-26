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
