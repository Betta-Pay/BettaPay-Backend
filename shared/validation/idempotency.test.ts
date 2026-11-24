/**
 * idempotency.test.ts (#764)
 *
 * Unit tests for the canonical withIdempotency helper. Pure addition — no
 * call-site changes. Covers the acceptance criteria: lookup-hit,
 * Redis-claim race, Redis-down fallback, and P2002-winner paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  IdempotencyConflictError,
  withIdempotency,
  type IdempotencyRedis,
} from "./idempotency.js";

function stubRedis(overrides: Partial<IdempotencyRedis> = {}): IdempotencyRedis & {
  calls: { set: number; get: number; del: number };
} {
  const calls = { set: 0, get: 0, del: 0 };
  return {
    calls,
    get: async (_key: string) => {
      calls.get += 1;
      return null;
    },
    set: async (_key: string, _value: string) => {
      calls.set += 1;
      return "OK";
    },
    del: async (_key: string) => {
      calls.del += 1;
      return 1;
    },
    ...overrides,
  };
}

test("withIdempotency: lookup-hit returns the existing record without creating", async () => {
  const redis = stubRedis();
  let creates = 0;
  const existing = { id: "pay_existing" };

  const out = await withIdempotency({
    key: "key-1",
    redis,
    lookupExisting: async () => existing,
    create: async () => {
      creates += 1;
      return { id: "pay_new" };
    },
  });

  assert.deepEqual(out, { result: existing, deduped: true, source: "lookup-hit" });
  assert.equal(creates, 0);
  assert.equal(redis.calls.set, 0);
});

test("withIdempotency: Redis-claim race resolves the winner without creating", async () => {
  const winner = { id: "set_winner" };
  const redis = stubRedis({
    // NX claim lost: another request claimed first.
    set: async () => null,
    get: async () => "set_winner",
  });
  let creates = 0;

  const out = await withIdempotency({
    key: "key-race",
    redis,
    lookupExisting: async () => null,
    resolveClaim: async (stored) => (stored === "set_winner" ? winner : null),
    create: async () => {
      creates += 1;
      return { id: "set_loser" };
    },
  });

  assert.deepEqual(out, { result: winner, deduped: true, source: "redis-race" });
  assert.equal(creates, 0);
});

test("withIdempotency: Redis-down fallback still creates via the DB guard", async () => {
  const redis = stubRedis({
    set: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const created = { id: "pay_created" };

  const out = await withIdempotency({
    key: "key-noredis",
    redis,
    lookupExisting: async () => null,
    create: async () => created,
  });

  assert.deepEqual(out, { result: created, deduped: false, source: "created" });
});

test("withIdempotency: P2002-winner maps a lost create race to the winner", async () => {
  const winner = { id: "set_p2002_winner" };
  let lookups = 0;

  const out = await withIdempotency({
    key: "key-p2002",
    redis: null,
    lookupExisting: async () => {
      lookups += 1;
      return lookups === 1 ? null : winner;
    },
    create: async () => {
      throw { code: "P2002" };
    },
  });

  assert.deepEqual(out, { result: winner, deduped: true, source: "p2002-winner" });
  assert.equal(lookups, 2);
});

test("withIdempotency: no key skips every guard and creates directly", async () => {
  const created = { id: "pay_nokey" };
  const out = await withIdempotency({
    key: null,
    create: async () => created,
  });

  assert.deepEqual(out, { result: created, deduped: false, source: "created" });
});

test("withIdempotency: bulk-hash mismatch throws instead of replaying", async () => {
  const redis = stubRedis({
    set: async () => null,
    get: async () => "hash-of-other-payload",
  });

  await assert.rejects(
    () =>
      withIdempotency({
        key: "key-bulk",
        redis,
        payloadHash: "hash-of-this-payload",
        lookupExisting: async () => null,
        create: async () => ({ id: "never" }),
      }),
    IdempotencyConflictError,
  );
});

test("withIdempotency: releases Redis claim key when create() throws so subsequent retries succeed (#1069)", async () => {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  const redis: IdempotencyRedis = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, value, ...args) => {
      const hasNx = args.includes("NX");
      if (hasNx && store.has(k)) return null;
      store.set(k, value);
      return "OK";
    },
    del: async (k) => {
      deletedKeys.push(k);
      return store.delete(k) ? 1 : 0;
    },
  };

  let attempts = 0;
  const transientError = new Error("transient DB timeout");

  await assert.rejects(
    () =>
      withIdempotency({
        key: "key-retry",
        redis,
        lookupExisting: async () => null,
        create: async () => {
          attempts += 1;
          throw transientError;
        },
      }),
    (err) => err === transientError,
  );

  assert.deepEqual(deletedKeys, ["idempotency:key-retry"]);
  assert.equal(store.has("idempotency:key-retry"), false);
  assert.equal(attempts, 1);

  const created = { id: "pay_retried" };
  const retryOut = await withIdempotency({
    key: "key-retry",
    redis,
    lookupExisting: async () => null,
    create: async () => {
      attempts += 1;
      return created;
    },
  });

  assert.deepEqual(retryOut, { result: created, deduped: false, source: "created" });
  assert.equal(attempts, 2);
  assert.equal(store.has("idempotency:key-retry"), true);
});

test("withIdempotency: rethrows original create() error even if Redis del() fails during cleanup (#1069)", async () => {
  const createError = new Error("primary DB write failed");
  const redis = stubRedis({
    del: async () => {
      throw new Error("redis unavailable");
    },
  });

  await assert.rejects(
    () =>
      withIdempotency({
        key: "key-del-fail",
        redis,
        lookupExisting: async () => null,
        create: async () => {
          throw createError;
        },
      }),
    (err) => err === createError,
  );
});
