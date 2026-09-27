import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

test('authenticate decorator should return generic 401 on invalid JWT on gateway app', async (t) => {
  const { app } = await createTestApp();

  try {
    // Test 1: Invalid JWT token should return 401 with generic message on a protected gateway endpoint
    const response1 = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: 'Bearer invalid_token' }
    });

    t.equal(response1.statusCode, 401, 'Status code should be 401');
    const body1 = JSON.parse(response1.body);
    t.equal(body1.error.message, 'Unauthorized', 'Error message should be generic "Unauthorized"');
    t.notOk(response1.body.includes('fast-jwt'), 'Response should not contain fast-jwt error details');
    t.notOk(response1.body.includes('ERR_'), 'Response should not contain error codes');

    // Test 2: Missing authorization header should return 401
    const response2 = await app.inject({
      method: 'POST',
      url: '/api/payments'
    });

    t.equal(response2.statusCode, 401, 'Status code should be 401 for missing auth');
    const body2 = JSON.parse(response2.body);
    t.equal(body2.error.message, 'Unauthorized', 'Error message should be generic "Unauthorized" for missing auth');
    t.notOk(response2.body.includes('Missing'), 'Response should not contain "Missing" error text');

    // Test 3: Valid JWT token should pass through
    const token = generateTestJwt(app);
    const response3 = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantId: 'm1', amount: '10.00', asset: 'USDC' }
    });

    t.notEqual(response3.statusCode, 401, 'Valid JWT should pass authentication');

    await app.close();
    t.end();
  } catch (err) {
    t.fail(err as any);
    await app.close();
    t.end();
  }
});
