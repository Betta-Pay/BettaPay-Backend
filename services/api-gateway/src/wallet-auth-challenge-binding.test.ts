import test from 'tape';
import Fastify from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import {
  consumeWalletChallenge,
  storeWalletChallenge,
  walletChallengeKey,
  WALLET_CHALLENGE_TTL_MS,
  type StoredWalletChallenge,
} from './wallet-auth-challenge.js';

// #469 — the challenge/nonce is now stored server-side, bound to the address,
// and consumed atomically on verify. A replay of an already-verified signed
// challenge must be rejected with 409.

interface FakeRedis {
  store: Map<string, string>;
  failing: boolean;
  set(key: string, value: string, mode: string, ttl: number): Promise<'OK'>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<string | null>;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    failing: false,
    async set(key, value) {
      if (this.failing) throw new Error('Redis connection failed');
      store.set(key, value);
      return 'OK';
    },
    async eval(script, _n, ...args) {
      if (this.failing) throw new Error('Redis connection failed');
      // GET + DEL (consumeScript)
      const key = args[0];
      const v = store.get(key) ?? null;
      if (v !== null) store.delete(key);
      return v;
    },
  };
}

function makeChallenge(address: string, overrides: Partial<StoredWalletChallenge> = {}): StoredWalletChallenge {
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    challenge: `BettaPay:${address}:${nonce}`,
    nonce,
    address,
    expiresAt: Date.now() + WALLET_CHALLENGE_TTL_MS,
    ...overrides,
  };
}

test('consumeWalletChallenge: round-trips the stored record then returns null (single-use)', async (t) => {
  const redis = fakeRedis();
  const address = 'GABC123';
  const rec = makeChallenge(address);

  await storeWalletChallenge(redis as never, rec);
  t.ok(redis.store.has(walletChallengeKey(address)), 'challenge is stored under the address key');

  const first = await consumeWalletChallenge(redis as never, address);
  t.deepEqual(first, rec, 'first consume returns the record');

  const second = await consumeWalletChallenge(redis as never, address);
  t.equal(second, null, 'second consume returns null — the challenge is gone');
  t.end();
});

test('consumeWalletChallenge: returns null for an address that was never issued a challenge', async (t) => {
  const redis = fakeRedis();
  t.equal(await consumeWalletChallenge(redis as never, 'GNOPE'), null, 'null when nothing pending');
  t.end();
});

// A trimmed copy of the real /verify decision flow, wired to the real helpers.
function buildAuthApp(redis: FakeRedis, verifySig: (a: string, c: string, s: string) => boolean) {
  const app = Fastify({ logger: false });
  const Body = z.object({
    address: z.string().min(1),
    nonce: z.string().optional(),
    challenge: z.string().min(1).optional(),
    signature: z.string().min(1),
  });

  app.get<{ Querystring: { address: string } }>('/challenge', async (req, reply) => {
    const address = String((req.query as { address?: string }).address ?? '');
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = `BettaPay:${address}:${nonce}`;
    const expiresAt = Date.now() + WALLET_CHALLENGE_TTL_MS;
    try {
      await storeWalletChallenge(redis as never, { challenge, nonce, address, expiresAt });
    } catch {
      return reply.code(503).send({ error: 'Authentication service unavailable' });
    }
    return reply.send({ challenge, nonce, expiresAt });
  });

  app.post('/verify', async (req, reply) => {
    const d = Body.parse(req.body);
    let stored: StoredWalletChallenge | null;
    try {
      stored = await consumeWalletChallenge(redis as never, d.address);
    } catch {
      return reply.code(503).send({ error: 'Authentication service unavailable' });
    }
    if (!stored || stored.address !== d.address || Date.now() > stored.expiresAt) {
      return reply.code(409).send({ error: 'Challenge expired or already used' });
    }
    // Nonce binding (#616): the supplied nonce must be the one the server
    // bound to this address. Rejecting a mismatched nonce closes the
    // cross-address replay where a victim's signed challenge is re-posted
    // under the attacker's address.
    if (d.nonce && d.nonce !== stored.nonce) {
      return reply.code(409).send({ error: 'Challenge does not match the one issued' });
    }
    if (d.challenge && d.challenge !== stored.challenge) {
      return reply.code(409).send({ error: 'Challenge does not match the one issued' });
    }
    if (!verifySig(d.address, stored.challenge, d.signature)) {
      return reply.code(401).send({ error: 'Invalid wallet signature' });
    }
    return reply.send({ token: 'ok' });
  });

  return app;
}

test('replay of an already-verified signed challenge is rejected with 409', async (t) => {
  const redis = fakeRedis();
  const app = buildAuthApp(redis, () => true); // signature always "valid"
  const address = 'GREPLAY';

  const chRes = await app.inject({ method: 'GET', url: `/challenge?address=${address}` });
  const { challenge } = JSON.parse(chRes.body);

  const ok = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address, challenge, signature: 'sig' },
  });
  t.equal(ok.statusCode, 200, 'first verify succeeds');

  const replay = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address, challenge, signature: 'sig' },
  });
  t.equal(replay.statusCode, 409, 'replayed challenge is rejected with 409');

  await app.close();
  t.end();
});

test('an expired challenge is rejected with 409', async (t) => {
  const redis = fakeRedis();
  const address = 'GEXPIRED';
  await storeWalletChallenge(
    redis as never,
    makeChallenge(address, { expiresAt: Date.now() - 1 }),
  );
  const app = buildAuthApp(redis, () => true);

  const res = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address, signature: 'sig' },
  });
  t.equal(res.statusCode, 409, 'expired challenge -> 409');

  await app.close();
  t.end();
});

test('a signed challenge for a different address is rejected (binding)', async (t) => {
  const redis = fakeRedis();
  const app = buildAuthApp(redis, () => true);

  await app.inject({ method: 'GET', url: '/challenge?address=GALICE' });
  // Bob presents Alice's flow by claiming address GALICE was never his; his own
  // address has no pending challenge.
  const res = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address: 'GBOB', challenge: 'BettaPay:GBOB:whatever', signature: 'sig' },
  });
  t.equal(res.statusCode, 409, 'no challenge bound to GBOB -> 409');

  await app.close();
  t.end();
});

test('cross-address replay: victim-issue + attacker-address + nonce is rejected with 409 (#616)', async (t) => {
  const redis = fakeRedis();
  const app = buildAuthApp(redis, () => true);

  // Victim requests and signs a challenge bound to GALICE.
  const chRes = await app.inject({
    method: 'GET',
    url: '/challenge?address=GALICE',
  });
  const { challenge, nonce } = JSON.parse(chRes.body);

  // Attacker posts the victim's signed challenge under their own address,
  // echoing the victim's nonce but claiming a different address. The stored
  // record is consumed keyed by the attacker's address, so nothing is found
  // and the request is rejected with 409.
  const atk = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address: 'GATTACKER', nonce, challenge, signature: 'sig' },
  });
  t.equal(atk.statusCode, 409, 'challenge store is keyed by address — attacker has no challenge');

  await app.close();
  t.end();
});

test('a mismatched nonce is rejected even when the address matches (#616)', async (t) => {
  const redis = fakeRedis();
  const app = buildAuthApp(redis, () => true);

  const chRes = await app.inject({ method: 'GET', url: '/challenge?address=GALICE' });
  const { challenge } = JSON.parse(chRes.body);

  // Correct address and challenge, but the attacker swaps the nonce for a
  // value the server never bound to GALICE — the verify must reject it.
  const res = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address: 'GALICE', nonce: 'forged-nonce', challenge, signature: 'sig' },
  });
  t.equal(res.statusCode, 409, 'mismatched nonce is rejected with 409');

  await app.close();
  t.end();
});

test('challenge store failure surfaces as 503, not 500', async (t) => {
  const redis = fakeRedis();
  redis.failing = true;
  const app = buildAuthApp(redis, () => true);

  const chRes = await app.inject({ method: 'GET', url: '/challenge?address=GDOWN' });
  t.equal(chRes.statusCode, 503, 'challenge issue -> 503 when Redis is down');

  const vRes = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { address: 'GDOWN', signature: 'sig' },
  });
  t.equal(vRes.statusCode, 503, 'verify -> 503 when Redis is down');

  await app.close();
  t.end();
});
