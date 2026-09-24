import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

test('CSRF: POST with matching Origin header is allowed', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'http://localhost:3000',
      },
      payload: { id: 'm2', name: 'Test', ownerId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
    });

    t.equal(res.statusCode, 201, 'matching origin is allowed');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: POST with disallowed Origin header returns 403', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example.com',
      },
      payload: { id: 'm2', name: 'Test', ownerId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
    });

    t.equal(res.statusCode, 403, 'disallowed origin returns 403');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'INVALID_ORIGIN', 'returns INVALID_ORIGIN error code');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: POST without Origin header or CSRF token is rejected', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: { id: 'm2', name: 'Test', ownerId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
    });

    t.equal(res.statusCode, 403, 'no origin header without CSRF token is rejected');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'INVALID_ORIGIN', 'returns INVALID_ORIGIN error code');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: POST without Origin header but with x-csrf-check is allowed', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      headers: {
        authorization: `Bearer ${token}`,
        'x-csrf-check': '1',
      },
      payload: { id: 'm2', name: 'Test', ownerId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
    });

    t.equal(res.statusCode, 201, 'no origin header with CSRF token is allowed');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: GET requests bypass origin check', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1', name: 'M1', ownerId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/merchants/m1',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example.com',
      },
    });

    t.equal(res.statusCode, 200, 'GET bypasses origin check');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: PATCH with disallowed Origin returns 403', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1', settings: {} }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/merchants/m1/settings',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example.com',
      },
      payload: { feeBps: 50 },
    });

    t.equal(res.statusCode, 403, 'PATCH with bad origin returns 403');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('CSRF: DELETE with disallowed Origin returns 403', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ id: 'm1' }] });
  const token = generateTestJwt(app);

  try {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/merchants/m1',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example.com',
      },
    });

    t.equal(res.statusCode, 403, 'DELETE with bad origin returns 403');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});
