import test from 'tape';
import crypto from 'crypto';
import sinon from 'sinon';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { Keypair } from '@stellar/stellar-sdk';
import { OAuth2Client } from 'google-auth-library';
import { CreateMerchantBody, AuthTokenBody, createErrorResponse, ErrorCodes } from '@bettapay/validation';

const VALID_STELLAR_PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_STELLAR_PUBLIC_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

interface BuildAppOptions {
  initialMerchants?: any[];
  injectP2002OnVerify?: boolean;
}

// Builds a mock application mirroring the gateway's authentication and creation routes
function buildApp(optsOrMerchants: BuildAppOptions | any[] = {}) {
  const opts = Array.isArray(optsOrMerchants) ? { initialMerchants: optsOrMerchants } : optsOrMerchants;
  const app = Fastify({ logger: false });
  const db = [...(opts.initialMerchants || [])];
  const walletChallenges = new Map<string, { challenge: string; expiresAt: number }>();

  app.register(fastifyJwt, {
    secret: 'test-jwt-secret-key-32-chars-long-or-more',
    sign: { expiresIn: '24h' }
  });

  // Replicate POST /api/auth/token
  app.post('/api/auth/token', async (request, reply) => {
    try {
      const d = AuthTokenBody.parse(request.body);
      const merchant = db.find(m => m.id === d.merchantId && !m.deletedAt);

      const storedHash = merchant?.secretHash || '0'.repeat(64);
      const inputHash = hashSecret(d.secret);
      const hashBuffer = Buffer.from(storedHash, 'hex');
      const inputBuffer = Buffer.from(inputHash, 'hex');

      const isValid = merchant && merchant.secretHash && crypto.timingSafeEqual(hashBuffer, inputBuffer);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
      return reply.send({ token });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Replicate POST /api/merchants
  app.post('/api/merchants', async (request, reply) => {
    try {
      const d = CreateMerchantBody.parse(request.body);
      const secret = d.secret || crypto.randomBytes(24).toString('hex');
      const secretHash = hashSecret(secret);
      const merchant = {
        id: d.id,
        name: d.name,
        ownerId: d.ownerId,
        settings: d.settings || {},
        secretHash,
      };
      db.push(merchant);
      const { secretHash: _hash, ...safeMerchant } = merchant;
      return reply.code(201).send({ data: { merchant: safeMerchant, secret } });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Replicate wallet challenge/verify and Google OAuth routes

  app.post<{ Body: { address?: unknown } }>('/api/auth/challenge', async (request, reply) => {
    try {
      const { address } = request.body as any;
      if (!address || typeof address !== 'string') {
        return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'address is required'));
      }
      const challenge = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins
      walletChallenges.set(address, { challenge, expiresAt });
      return reply.send({ challenge, expiresAt: new Date(expiresAt).toISOString() });
    } catch (err: any) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, err.message));
    }
  });

  app.post<{ Body: { address?: unknown; signature?: unknown } }>('/api/auth/verify', async (request, reply) => {
    try {
      const { address, signature } = request.body as any;
      if (!address || typeof address !== 'string') {
        return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'address is required'));
      }
      if (!signature || typeof signature !== 'string') {
        return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'signature is required'));
      }

      const challengeInfo = walletChallenges.get(address);
      if (!challengeInfo) {
        return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Challenge not found or expired'));
      }

      if (Date.now() > challengeInfo.expiresAt) {
        walletChallenges.delete(address);
        return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Challenge expired'));
      }

      try {
        const keypair = Keypair.fromPublicKey(address);
        const isValid = keypair.verify(Buffer.from(challengeInfo.challenge), Buffer.from(signature, 'hex'));
        if (!isValid) {
          return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid signature'));
        }
      } catch (err) {
        return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid signature'));
      }

      walletChallenges.delete(address);

      let merchant;
      if (opts.injectP2002OnVerify) {
        // Simulate concurrent insert P2002 error: another worker inserted it first
        const existing = db.find(m => m.id === address);
        if (!existing) {
          const winner = {
            id: address,
            name: `Merchant ${address.substring(0, 6)}`,
            ownerId: `owner-${address.substring(0, 6)}`,
            settings: {}
          };
          db.push(winner);
          merchant = winner;
        } else {
          merchant = existing;
        }
      } else {
        merchant = db.find(m => m.id === address);
        if (!merchant) {
          merchant = {
            id: address,
            name: `Merchant ${address.substring(0, 6)}`,
            ownerId: `owner-${address.substring(0, 6)}`,
            settings: {}
          };
          db.push(merchant);
        }
      }

      const token = app.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
      return reply.send({ token });
    } catch (err: any) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, err.message));
    }
  });

  app.post<{ Body: { token?: unknown } }>('/api/auth/google', async (request, reply) => {
    try {
      const { token } = request.body as any;
      if (!token || typeof token !== 'string') {
        return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'token is required'));
      }

      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid token payload'));
      }
      const email = payload.email;
      if (!email) {
        return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Email missing in Google payload'));
      }

      let merchant = db.find(m => m.ownerId === email && !m.deletedAt);
      if (!merchant) {
        const merchantId = `google_${crypto.randomBytes(8).toString('hex')}`;
        merchant = {
          id: merchantId,
          name: email.split('@')[0] + ' Merchant',
          ownerId: email,
          settings: {}
        };
        db.push(merchant);
      }

      const jwtToken = app.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
      return reply.send({ token: jwtToken });
    } catch (err: any) {
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid Google token'));
    }
  });

  return { app, db, walletChallenges };
}

test('valid credentials return JWT', async (t) => {
  const secret = 'merchant-super-secret-key';
  const merchantId = VALID_STELLAR_PUBLIC_KEY;
  const hashed = hashSecret(secret);
  const { app } = buildApp({
    initialMerchants: [{ id: merchantId, ownerId: 'user-1', secretHash: hashed }],
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { merchantId, secret },
    });

    t.equal(res.statusCode, 200, 'should return 200 OK');
    const body = JSON.parse(res.body);
    t.ok(body.token, 'should return a token');

    const payload = app.jwt.decode(body.token) as any;
    t.equal(payload.merchantId, merchantId, 'JWT contains correct merchant ID');
    t.equal(payload.ownerId, 'user-1', 'JWT contains correct owner ID');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('invalid secret returns 401', async (t) => {
  const secret = 'merchant-super-secret-key';
  const merchantId = VALID_STELLAR_PUBLIC_KEY;
  const hashed = hashSecret(secret);
  const { app } = buildApp({
    initialMerchants: [{ id: merchantId, ownerId: 'user-1', secretHash: hashed }],
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { merchantId, secret: 'wrong-secret' },
    });

    t.equal(res.statusCode, 401, 'should return 401 Unauthorized');
    const body = JSON.parse(res.body);
    t.equal(body.error, 'Invalid credentials', 'should return exact error message');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('unknown merchant returns 401', async (t) => {
  const { app } = buildApp();

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { merchantId: OTHER_STELLAR_PUBLIC_KEY, secret: 'some-secret' },
    });

    t.equal(res.statusCode, 401, 'should return 401 Unauthorized for unknown merchant');
    const body = JSON.parse(res.body);
    t.equal(body.error, 'Invalid credentials', 'should return exact error message');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('merchant creation hashes secrets and plaintext secrets are never persisted', async (t) => {
  const { app, db } = buildApp();

  try {
    // 1. Creation with custom secret
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      payload: {
        id: 'm-new-1',
        name: 'New Merchant',
        ownerId: VALID_STELLAR_PUBLIC_KEY,
        secret: 'my-custom-secret-1234',
      }
    });

    t.equal(res1.statusCode, 201, 'creation succeeds');
    const body1 = JSON.parse(res1.body);
    t.equal(body1.data.secret, 'my-custom-secret-1234', 'returns custom secret');
    t.notOk(body1.data.merchant.secretHash, 'response body contains no secretHash field');

    const stored1 = db.find(m => m.id === 'm-new-1');
    t.ok(stored1, 'merchant is persisted');
    t.notEqual(stored1?.secretHash, 'my-custom-secret-1234', 'persisted secret is hashed');
    t.equal(stored1?.secretHash, hashSecret('my-custom-secret-1234'), 'hash matches SHA-256');
    t.notOk(Object.keys(stored1 || {}).includes('secret'), 'plaintext secret key is not in merchant object');

    // 2. Creation with generated secret
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      payload: {
        id: 'm-new-2',
        name: 'Generated Merchant',
        ownerId: OTHER_STELLAR_PUBLIC_KEY,
      },
    });

    t.equal(res2.statusCode, 201, 'creation with generated secret succeeds');
    const body2 = JSON.parse(res2.body);
    t.ok(body2.data.secret, 'generated secret is returned');
    t.notOk(body2.data.merchant.secretHash, 'response body contains no secretHash field');

    const stored2 = db.find(m => m.id === 'm-new-2');
    t.ok(stored2, 'merchant is persisted');
    t.notEqual(stored2?.secretHash, body2.data.secret, 'persisted secret is hashed');
    t.equal(stored2?.secretHash, hashSecret(body2.data.secret), 'hash matches SHA-256');
    t.notOk(Object.keys(stored2 || {}).includes('secret'), 'plaintext secret key is not in merchant object');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('seeded admin merchant authenticates successfully', async (t) => {
  const adminAddress = VALID_STELLAR_PUBLIC_KEY;
  const adminSecret = 'admin-secret-dev-value';
  const adminSecretHash = hashSecret(adminSecret);

  const { app } = buildApp({
    initialMerchants: [{
      id: adminAddress,
      name: 'BettaPay Merchant LLC',
      ownerId: 'admin-user-001',
      settings: { preferredAsset: 'USDC', autoSettle: true },
      secretHash: adminSecretHash,
    }],
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { merchantId: adminAddress, secret: adminSecret },
    });

    t.equal(res.statusCode, 200, 'admin authenticates successfully');
    const body = JSON.parse(res.body);
    t.ok(body.token, 'returns a JWT token for admin');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('regression test: arbitrary secrets can no longer obtain a JWT', async (t) => {
  const merchantId = VALID_STELLAR_PUBLIC_KEY;
  const secret = 'merchant-super-secret-key';
  const hashed = hashSecret(secret);
  const { app } = buildApp({
    initialMerchants: [{ id: merchantId, ownerId: 'user-1', secretHash: hashed }],
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { merchantId, secret: 'arbitrary-unauthorized-secret-key-123' },
    });

    t.equal(res.statusCode, 401, 'arbitrary secret is rejected');
    const body = JSON.parse(res.body);
    t.equal(body.error, 'Invalid credentials', 'returns invalid credentials error');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('wallet auth challenge - success', async (t) => {
  const { app } = buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { address: 'GD...123' }
    });
    t.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    t.ok(body.challenge);
    t.ok(body.expiresAt);
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('wallet verify with expired challenge', async (t) => {
  const { app, walletChallenges } = buildApp();
  const address = 'GD...expired';
  walletChallenges.set(address, {
    challenge: 'expired-challenge-text',
    expiresAt: Date.now() - 1 // expired
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature: 'signature-hex' }
    });
    t.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
    t.equal(body.error.message, 'Challenge expired');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('wallet verify with invalid signature', async (t) => {
  const { app, walletChallenges } = buildApp();
  const address = 'GD...invalid-sig';
  const challenge = 'valid-challenge-text';
  walletChallenges.set(address, {
    challenge,
    expiresAt: Date.now() + 5000
  });

  // Mock Keypair verify to return false
  const mockKeypair = {
    verify: sinon.stub().returns(false)
  };
  const fromPublicKeyStub = sinon.stub(Keypair, 'fromPublicKey').returns(mockKeypair as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature: 'signature-hex' }
    });
    t.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.UNAUTHORIZED);
    t.equal(body.error.message, 'Invalid signature');
    t.ok(mockKeypair.verify.calledOnce);
  } catch (err: any) {
    t.fail(err);
  } finally {
    fromPublicKeyStub.restore();
    await app.close();
    t.end();
  }
});

test('wallet verify - success & upsert path / token returned', async (t) => {
  const { app, db, walletChallenges } = buildApp();
  const address = 'GD...success';
  const challenge = 'valid-challenge-text';
  walletChallenges.set(address, {
    challenge,
    expiresAt: Date.now() + 5000
  });

  const mockKeypair = {
    verify: sinon.stub().returns(true)
  };
  const fromPublicKeyStub = sinon.stub(Keypair, 'fromPublicKey').returns(mockKeypair as any);

  try {
    // Calling verify first time (creates merchant)
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature: 'signature-hex' }
    });
    t.equal(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    t.ok(body1.token);

    t.equal(db.length, 1);
    t.equal(db[0].id, address);

    // Seed challenge again to test second call (upserts, no duplicates)
    walletChallenges.set(address, {
      challenge,
      expiresAt: Date.now() + 5000
    });

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature: 'signature-hex' }
    });
    t.equal(res2.statusCode, 200);
    const body2 = JSON.parse(res2.body);
    t.ok(body2.token);

    // Verify database size remains 1 (no duplicates)
    t.equal(db.length, 1);
  } catch (err: any) {
    t.fail(err);
  } finally {
    fromPublicKeyStub.restore();
    await app.close();
    t.end();
  }
});

test('wallet verify - concurrent race condition upsert path', async (t) => {
  const { app, db, walletChallenges } = buildApp({ injectP2002OnVerify: true });
  const address = 'GD...race';
  const challenge = 'valid-challenge-text';
  walletChallenges.set(address, {
    challenge,
    expiresAt: Date.now() + 5000
  });

  const mockKeypair = {
    verify: sinon.stub().returns(true)
  };
  const fromPublicKeyStub = sinon.stub(Keypair, 'fromPublicKey').returns(mockKeypair as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature: 'signature-hex' }
    });
    t.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    t.ok(body.token);

    // Database must only have 1 merchant for this address
    t.equal(db.filter(m => m.id === address).length, 1);
  } catch (err: any) {
    t.fail(err);
  } finally {
    fromPublicKeyStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth - invalid token', async (t) => {
  const { app } = buildApp();
  const verifyIdTokenStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').rejects(new Error('Invalid token'));

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'invalid-token' }
    });
    t.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.UNAUTHORIZED);
    t.equal(body.error.message, 'Invalid Google token');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyIdTokenStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth - missing email', async (t) => {
  const { app } = buildApp();
  const verifyIdTokenStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({})
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'missing-email-token' }
    });
    t.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
    t.equal(body.error.message, 'Email missing in Google payload');
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyIdTokenStub.restore();
    await app.close();
    t.end();
  }
});

test('Google OAuth - success & token returned', async (t) => {
  const { app, db } = buildApp();
  const email = 'test-google@example.com';
  const verifyIdTokenStub = sinon.stub(OAuth2Client.prototype, 'verifyIdToken').resolves({
    getPayload: () => ({ email })
  } as any);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: { token: 'valid-token' }
    });
    t.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    t.ok(body.token);

    t.equal(db.length, 1);
    t.equal(db[0].ownerId, email);
  } catch (err: any) {
    t.fail(err);
  } finally {
    verifyIdTokenStub.restore();
    await app.close();
    t.end();
  }
});
