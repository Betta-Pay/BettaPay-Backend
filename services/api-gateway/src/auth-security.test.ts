import test from 'tape';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import {
  AuthIpScoreQuery,
  AuthTokenBody,
  WalletVerifyBody,
  createErrorResponse,
  ErrorCodes,
} from '@bettapay/validation';

interface MerchantRecord {
  id: string;
  ownerId: string;
  secretHash: string;
  deletedAt?: Date | null;
}

interface MerchantJwtPayload {
  merchantId?: string;
  ownerId?: string;
  jti?: string;
  exp?: number;
}

class MemoryRedis {
  private values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async incrby(key: string, delta: number): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + delta;
    this.values.set(key, String(next));
    return next;
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return this.values.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function authIpScoreKey(ip: string): string {
  return 'auth_ip_score:' + ip;
}

function revokedJtiKey(jti: string): string {
  return 'revoked_jti:' + jti;
}

function usedNonceKey(nonce: string): string {
  return 'used_nonce:' + nonce;
}

function refreshRateKey(merchantId: string): string {
  return 'auth_refresh_rate:' + merchantId;
}

function buildApp(initialMerchants: MerchantRecord[], adminMerchantId = initialMerchants[0]?.id ?? '') {
  const app = Fastify({ logger: false });
  const redis = new MemoryRedis();
  const merchants = [...initialMerchants];
  const authIpThreshold = 20;

  app.register(fastifyJwt, {
    secret: 'test-jwt-secret-key-32-chars-long-or-more',
    sign: { expiresIn: '24h' },
  });

  function signMerchantJwt(merchantId: string, ownerId: string, expiresIn = '24h'): string {
    return app.jwt.sign({ merchantId, ownerId, jti: crypto.randomUUID() }, { expiresIn });
  }

  function getRequestIp(request: FastifyRequest): string {
    return request.ip;
  }

  async function getAuthIpScore(ip: string): Promise<number> {
    return Number(await redis.get(authIpScoreKey(ip)) ?? '0');
  }

  async function updateAuthIpScore(ip: string, delta: number): Promise<number> {
    const key = authIpScoreKey(ip);
    if (delta > 0) {
      const score = await redis.incrby(key, delta);
      await redis.expire(key, 15 * 60);
      return score;
    }

    const current = Number(await redis.get(key) ?? '0');
    const next = Math.max(0, current + delta);
    if (next === 0) await redis.del(key);
    else await redis.set(key, String(next), 'EX', 15 * 60);
    return next;
  }

  async function enforceAuthIpReputation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (await getAuthIpScore(getRequestIp(request)) >= authIpThreshold) {
      await reply
        .header('Retry-After', '300')
        .code(429)
        .send(createErrorResponse(ErrorCodes.RATE_LIMITED, 'Too many failed authentication attempts'));
    }
  }

  async function recordAuthIpFailure(request: FastifyRequest): Promise<void> {
    await updateAuthIpScore(getRequestIp(request), 1);
  }

  async function recordAuthIpSuccess(request: FastifyRequest): Promise<void> {
    await updateAuthIpScore(getRequestIp(request), -1);
  }

  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      const payload = request.user as MerchantJwtPayload;
      if (payload.jti && await redis.exists(revokedJtiKey(payload.jti))) {
        return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
      }
    } catch {
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }
  });

  app.post('/api/auth/token', { preHandler: [enforceAuthIpReputation] }, async (request, reply) => {
    const d = AuthTokenBody.parse(request.body);
    const merchant = merchants.find((m) => m.id === d.merchantId && !m.deletedAt);
    const storedHash = merchant?.secretHash || '0'.repeat(64);
    const inputHash = hashSecret(d.secret);
    const hashesMatch = storedHash.length === inputHash.length && crypto.timingSafeEqual(
      Buffer.from(storedHash, 'hex'),
      Buffer.from(inputHash, 'hex')
    );

    if (!merchant || !merchant.secretHash || !hashesMatch) {
      await recordAuthIpFailure(request);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    await recordAuthIpSuccess(request);
    return reply.send({ token: signMerchantJwt(merchant.id, merchant.ownerId) });
  });

  app.post('/api/auth/refresh', { preHandler: [enforceAuthIpReputation] }, async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await recordAuthIpFailure(request);
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }

    const payload = request.user as MerchantJwtPayload;
    if (!payload.merchantId || !payload.ownerId || !payload.jti || !payload.exp) {
      await recordAuthIpFailure(request);
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }

    if (await redis.exists(revokedJtiKey(payload.jti))) {
      await recordAuthIpFailure(request);
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }

    const remainingLifetime = payload.exp - Math.floor(Date.now() / 1000);
    if (remainingLifetime <= 0) {
      await recordAuthIpFailure(request);
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }

    const rateKey = refreshRateKey(payload.merchantId);
    const refreshCount = await redis.incr(rateKey);
    if (refreshCount === 1) await redis.expire(rateKey, 60);
    if (refreshCount > 10) {
      return reply.header('Retry-After', '60').code(429).send(
        createErrorResponse(ErrorCodes.RATE_LIMITED, 'Too many token refresh requests')
      );
    }

    await redis.set(revokedJtiKey(payload.jti), '1', 'EX', remainingLifetime);
    await recordAuthIpSuccess(request);
    return reply.send({ token: signMerchantJwt(payload.merchantId, payload.ownerId) });
  });

  app.post('/api/auth/logout', { preValidation: [app.authenticate] }, async (request, reply) => {
    const payload = request.user as MerchantJwtPayload;
    if (!payload.jti || !payload.merchantId) {
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
    }

    const remainingLifetime = (payload.exp ?? 0) - Math.floor(Date.now() / 1000);
    if (remainingLifetime > 0) {
      await redis.set(revokedJtiKey(payload.jti), '1', 'EX', remainingLifetime);
    }
    return reply.send({ status: 'logged_out' });
  });

  app.post('/api/auth/wallet/verify', { preHandler: [enforceAuthIpReputation] }, async (request, reply) => {
    const d = WalletVerifyBody.parse(request.body);
    if (await redis.exists(usedNonceKey(d.nonce))) {
      await recordAuthIpFailure(request);
      return reply.code(409).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Nonce has already been used'));
    }

    const challenge = d.challenge ?? d.message ?? d.nonce;
    const valid = Keypair.fromPublicKey(d.address).verify(
      Buffer.from(challenge, 'utf8'),
      Buffer.from(d.signature, 'base64')
    );

    if (!valid) {
      await recordAuthIpFailure(request);
      return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid wallet signature'));
    }

    if (await redis.set(usedNonceKey(d.nonce), '1', 'EX', 5 * 60, 'NX') !== 'OK') {
      await recordAuthIpFailure(request);
      return reply.code(409).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Nonce has already been used'));
    }

    await recordAuthIpSuccess(request);
    return reply.send({ success: true, address: d.address });
  });

  app.get('/api/admin/auth/ip-score', { preValidation: [app.authenticate] }, async (request, reply) => {
    const payload = request.user as MerchantJwtPayload;
    if (payload.merchantId !== adminMerchantId) {
      return reply.code(403).send(createErrorResponse(ErrorCodes.FORBIDDEN, 'Forbidden'));
    }
    const { ip } = AuthIpScoreQuery.parse(request.query ?? {});
    return { ip, score: await getAuthIpScore(ip) };
  });

  app.get('/protected', { preValidation: [app.authenticate] }, async () => ({ ok: true }));

  return { app, redis, signMerchantJwt };
}

test('auth IP reputation blocks the 21st failed auth with a 5 minute retry window', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('correct-secret') }]);

  try {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/token',
        remoteAddress: '127.0.0.91',
        payload: { merchantId, secret: 'wrong-secret' },
      });
      t.equal(res.statusCode, 401, 'failed auth ' + (i + 1) + ' is counted before threshold');
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      remoteAddress: '127.0.0.91',
      payload: { merchantId, secret: 'wrong-secret' },
    });
    t.equal(blocked.statusCode, 429, '21st failed auth is reputation-limited');
    t.equal(blocked.headers['retry-after'], '300', 'uses 5 minute Retry-After');
  } finally {
    await app.close();
    t.end();
  }
});

test('successful auth decrements IP reputation score', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app, redis } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('correct-secret') }]);
  const ip = '127.0.0.92';

  try {
    await app.inject({ method: 'POST', url: '/api/auth/token', remoteAddress: ip, payload: { merchantId, secret: 'wrong' } });
    t.equal(await redis.get(authIpScoreKey(ip)), '1', 'failed auth increments score');

    const res = await app.inject({ method: 'POST', url: '/api/auth/token', remoteAddress: ip, payload: { merchantId, secret: 'correct-secret' } });
    t.equal(res.statusCode, 200, 'valid auth succeeds');
    t.equal(await redis.get(authIpScoreKey(ip)), null, 'successful auth decays score to zero');
  } finally {
    await app.close();
    t.end();
  }
});

test('auth IP reputation is isolated per IP address', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('correct-secret') }]);

  try {
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/token', remoteAddress: '127.0.0.93', payload: { merchantId, secret: 'wrong' } });
    }

    const otherIp = await app.inject({ method: 'POST', url: '/api/auth/token', remoteAddress: '127.0.0.94', payload: { merchantId, secret: 'wrong' } });
    t.equal(otherIp.statusCode, 401, 'different IP is not blocked by another IP score');
  } finally {
    await app.close();
    t.end();
  }
});

test('refresh returns a new JWT and revokes the old token', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app, signMerchantJwt } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('secret') }]);
  await app.ready();
  const token = signMerchantJwt(merchantId, merchantId);

  try {
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: 'Bearer ' + token } });
    t.equal(refreshed.statusCode, 200, 'refresh succeeds');
    const body = JSON.parse(refreshed.body) as { token: string };
    t.ok(body.token, 'new token returned');
    t.notEqual(body.token, token, 'new token differs from old token');

    const oldUse = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer ' + token } });
    t.equal(oldUse.statusCode, 401, 'old token is revoked');
  } finally {
    await app.close();
    t.end();
  }
});

test('refresh rejects an expired JWT', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app, signMerchantJwt } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('secret') }]);
  await app.ready();
  const token = signMerchantJwt(merchantId, merchantId, '1ms');

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: 'Bearer ' + token } });
    t.equal(res.statusCode, 401, 'expired token cannot refresh');
  } finally {
    await app.close();
    t.end();
  }
});

test('refresh is rate-limited to 10 requests per minute per merchant', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app, signMerchantJwt } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('secret') }]);
  await app.ready();
  let token = signMerchantJwt(merchantId, merchantId);

  try {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: 'Bearer ' + token } });
      t.equal(res.statusCode, 200, 'refresh ' + (i + 1) + ' succeeds');
      token = (JSON.parse(res.body) as { token: string }).token;
    }

    const limited = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: 'Bearer ' + token } });
    t.equal(limited.statusCode, 429, '11th refresh is rate-limited');
  } finally {
    await app.close();
    t.end();
  }
});

test('logout revokes the caller\'s token immediately', async (t) => {
  const keypair = Keypair.random();
  const merchantId = keypair.publicKey();
  const { app, signMerchantJwt } = buildApp([{ id: merchantId, ownerId: merchantId, secretHash: hashSecret('secret') }]);
  await app.ready();
  const token = signMerchantJwt(merchantId, merchantId);

  try {
    const before = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer ' + token } });
    t.equal(before.statusCode, 200, 'token works before logout');

    const loggedOut = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: 'Bearer ' + token } });
    t.equal(loggedOut.statusCode, 200, 'logout succeeds');

    const after = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer ' + token } });
    t.equal(after.statusCode, 401, 'the same token is rejected after logout');
  } finally {
    await app.close();
    t.end();
  }
});

test('wallet verification rejects reused nonces and accepts different nonces', async (t) => {
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const { app } = buildApp([]);

  function signatureFor(nonce: string): string {
    return keypair.sign(Buffer.from(nonce, 'utf8')).toString('base64');
  }

  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address, nonce: 'nonce-1', signature: signatureFor('nonce-1') },
    });
    t.equal(first.statusCode, 200, 'first nonce succeeds');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address, nonce: 'nonce-1', signature: signatureFor('nonce-1') },
    });
    t.equal(replay.statusCode, 409, 'same nonce is rejected');

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address, nonce: 'nonce-2', signature: signatureFor('nonce-2') },
    });
    t.equal(second.statusCode, 200, 'different nonce succeeds');
  } finally {
    await app.close();
    t.end();
  }
});
