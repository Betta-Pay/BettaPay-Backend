/**
 * jti-revocation.test.ts (issue #874)
 *
 * Gateway JWT jti revocation: revokeJti stores the token id under a TTL'd
 * Redis key, isJtiRevoked answers only for revoked ids, and the key format
 * matches the gateway authentication hook's `revoked_jti:<jti>` lookup.
 */
import test from 'tape';
import { createAuthHardening } from './auth-hardening.js';

const REVOKED_JTI_PREFIX = 'revoked_jti:';

interface FakeEntry {
  v: string;
  exp: number | null;
}

function createFakeRedis() {
  const data = new Map<string, FakeEntry>();
  const setCalls: Array<{ key: string; value: string; args: unknown[] }> = [];
  const now = () => Date.now();

  function getLive(key: string): FakeEntry | null {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.exp !== null && now() >= entry.exp) {
      data.delete(key);
      return null;
    }
    return entry;
  }

  return {
    data,
    setCalls,
    async set(key: string, value: string, ...args: unknown[]) {
      setCalls.push({ key, value, args });
      const modeIdx = args.findIndex((a) => a === 'EX' || a === 'PX');
      let exp: number | null = null;
      if (modeIdx !== -1) {
        const ttl = Number(args[modeIdx + 1]);
        exp = now() + (args[modeIdx] === 'EX' ? ttl * 1000 : ttl);
      }
      data.set(key, { v: value, exp });
      return 'OK';
    },
    async exists(key: string) {
      return getLive(key) ? 1 : 0;
    },
    async get(key: string) {
      return getLive(key)?.v ?? null;
    },
  };
}

function createHelpers(redis: ReturnType<typeof createFakeRedis>) {
  return createAuthHardening(redis as any, () => 'jwt');
}

test('#874: revoking a jti marks exactly that token as revoked', async (t) => {
  const helpers = createHelpers(createFakeRedis());

  t.equal(await helpers.isJtiRevoked('jti-1'), false, 'fresh token is not revoked');
  await helpers.revokeJti('jti-1', 300);
  t.equal(await helpers.isJtiRevoked('jti-1'), true, 'revoked token is rejected');
  t.equal(await helpers.isJtiRevoked('jti-2'), false, 'other tokens are unaffected');
  t.end();
});

test('#874: revoked jtis are stored under the documented key with a TTL', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.revokeJti('jti-abc', 300);

  t.equal(redis.setCalls.length, 1, 'one SET call');
  t.equal(redis.setCalls[0].key, `${REVOKED_JTI_PREFIX}jti-abc`, 'key is revoked_jti:<jti>');
  t.deepEqual(redis.setCalls[0].args, ['1', 'EX', 300], 'value 1 with EX <ttl seconds>');
  t.end();
});

test('#874: the TTL matches the token remaining lifetime so expiry self-heals', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.revokeJti('jti-ttl', 90);
  const entry = redis.data.get(`${REVOKED_JTI_PREFIX}jti-ttl`);
  t.ok(entry, 'marker stored');
  const remaining = (entry?.exp ?? 0) - Date.now();
  t.ok(remaining > 80_000 && remaining <= 90_000, 'expiry is the requested lifetime');
  t.end();
});

test('#874: non-positive TTLs are clamped to a one-second floor', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.revokeJti('jti-zero', 0);
  t.deepEqual(redis.setCalls[0].args, ['1', 'EX', 1], 'ttl 0 clamps to 1s');

  await helpers.revokeJti('jti-neg', -30);
  const last = redis.setCalls[redis.setCalls.length - 1];
  t.deepEqual(last.args, ['1', 'EX', 1], 'negative ttl clamps to 1s');
  t.end();
});

test('#874: a revoked jti stops being reported once its Redis marker expires', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.revokeJti('jti-expiring', 60);
  t.equal(await helpers.isJtiRevoked('jti-expiring'), true, 'revoked while the marker lives');

  // Simulate the TTL elapsing.
  const entry = redis.data.get(`${REVOKED_JTI_PREFIX}jti-expiring`);
  if (entry) entry.exp = Date.now() - 1;

  t.equal(await helpers.isJtiRevoked('jti-expiring'), false, 'marker reaped — token no longer flagged');
  t.end();
});

test('#874: revoking the same jti twice is idempotent', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.revokeJti('jti-twice', 300);
  await helpers.revokeJti('jti-twice', 300);
  t.equal(await helpers.isJtiRevoked('jti-twice'), true, 'still revoked after a second revoke');
  t.equal(redis.setCalls.length, 2, 'each revoke is a plain overwrite, no throw');
  t.end();
});
