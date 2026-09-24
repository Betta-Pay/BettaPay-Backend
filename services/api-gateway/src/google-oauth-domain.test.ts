import test from 'tape';
import sinon from 'sinon';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { OAuth2Client } from 'google-auth-library';
import { createErrorResponse, ErrorCodes } from '@bettapay/validation';
import { normalizeAndValidateEmail } from './index.js';

function buildGoogleAuthApp(opts: { allowedDomains?: string[] } = {}) {
  const app = Fastify({ logger: false });
  const db: any[] = [];

  app.register(fastifyJwt, {
    secret: 'test-jwt-secret-key-32-chars-long-or-more',
    sign: { expiresIn: '24h' },
  });

  const allowedDomains = opts.allowedDomains ?? [];

  app.post<{ Body: { token?: unknown } }>('/api/auth/google', async (request, reply) => {
    const { token } = request.body as any;
    if (!token || typeof token !== 'string') {
      return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'token is required'));
    }

    try {
      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Google token verification failed: invalid token payload'));
      }
      const rawEmail = payload.email;
      if (!rawEmail) {
        return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Email missing in Google token payload'));
      }

      const validated = normalizeAndValidateEmail(rawEmail);
      if (!validated) {
        return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Invalid email format'));
      }

      const { email: normalizedEmail, domain } = validated;

      if (allowedDomains.length > 0) {
        if (!domain || !allowedDomains.includes(domain)) {
          return reply.code(403).send(createErrorResponse(ErrorCodes.INVALID_ORIGIN, 'Email domain not allowed', { domain }));
        }
      }

      let merchant = db.find(m => m.ownerId === normalizedEmail && !m.deletedAt);
      if (!merchant) {
        merchant = { id: `google_test`, name: normalizedEmail.split('@')[0] + ' Merchant', ownerId: normalizedEmail, settings: {} };
        db.push(merchant);
      }

      const jwtToken = app.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
      return reply.send({ token: jwtToken });
    } catch (err: any) {
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Google token verification failed'));
    }
  });

  return { app, db };
}

test('Google OAuth: domain not in allowlist returns 403', async (t) => {
  const { app } = buildGoogleAuthApp({ allowedDomains: ['example.com', 'corp.com'] });
  const verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@evil.com' }),
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'valid-google-token' },
    });

    t.equal(res.statusCode, 403, 'returns 403 for disallowed domain');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'INVALID_ORIGIN', 'returns INVALID_ORIGIN error code');
    t.equal(body.error.details.domain, 'evil.com', 'includes domain in details');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth: domain in allowlist succeeds', async (t) => {
  const { app, db } = buildGoogleAuthApp({ allowedDomains: ['example.com'] });
  const verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@example.com' }),
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'valid-google-token' },
    });

    t.equal(res.statusCode, 200, 'returns 200 for allowed domain');
    const body = JSON.parse(res.body);
    t.ok(body.token, 'returns JWT token');
    t.equal(db.length, 1, 'merchant created');
    t.equal(db[0].ownerId, 'user@example.com');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth: adversarial email bypass attempts are rejected or normalized', async (t) => {
  const { app } = buildGoogleAuthApp({ allowedDomains: ['example.com'] });

  // Test 1: Subdomain spoofing attempt user@example.com.evil.com
  let verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@example.com.evil.com' }),
  } as any);

  let res = await app.inject({
    method: 'POST',
    url: '/api/auth/google',
    payload: { token: 'valid-token' },
  });
  t.equal(res.statusCode, 403, 'subdomain spoofing email rejected with 403');
  verifyStub.restore();

  // Test 2: Double @ symbol malformed email
  verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@evil.com@example.com' }),
  } as any);

  res = await app.inject({
    method: 'POST',
    url: '/api/auth/google',
    payload: { token: 'valid-token' },
  });
  t.equal(res.statusCode, 400, 'double @ malformed email rejected with 400');
  verifyStub.restore();

  // Test 3: Fullwidth unicode dot normalized to standard dot and succeeds
  verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@example\uFF0Ecom' }),
  } as any);

  res = await app.inject({
    method: 'POST',
    url: '/api/auth/google',
    payload: { token: 'valid-token' },
  });
  t.equal(res.statusCode, 200, 'fullwidth dot normalized and accepted');
  verifyStub.restore();

  await app.close();
  t.end();
});

test('Google OAuth: no domain restriction allows all emails', async (t) => {
  const { app, db } = buildGoogleAuthApp({});
  const verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email: 'user@any-domain.com' }),
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'valid-google-token' },
    });

    t.equal(res.statusCode, 200, 'returns 200 when no domain restriction');
    const body = JSON.parse(res.body);
    t.ok(body.token, 'returns JWT token');
    t.equal(db[0].ownerId, 'user@any-domain.com');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth: missing email in payload returns 400', async (t) => {
  const { app } = buildGoogleAuthApp({ allowedDomains: ['example.com'] });
  const verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({}),
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'token-without-email' },
    });

    t.equal(res.statusCode, 400, 'returns 400 for missing email');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'INVALID_REQUEST', 'returns INVALID_REQUEST');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth: invalid token returns 401', async (t) => {
  const { app } = buildGoogleAuthApp({ allowedDomains: ['example.com'] });
  const verifyStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').rejects(new Error('Invalid token'));

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'bad-token' },
    });

    t.equal(res.statusCode, 401, 'returns 401 for invalid token');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'UNAUTHORIZED', 'returns UNAUTHORIZED');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyStub.restore();
    await app.close();
    t.end();
  }
});
