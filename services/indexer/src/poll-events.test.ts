/**
 * Issue #1057 — Fix cursor advancement, genesis fallback, and leader lock in pollEvents.
 *
 * Verifies:
 *   1. Redis distributed leader lock prevents concurrent polling across replicas
 *      and is always released when a cycle finishes or fails.
 *   2. Missing/null cursor resolves from configured INDEX_FROM_LEDGER or RPC
 *      getLatestLedger() instead of falling back to startLedger: 0.
 *   3. latestLedgerCursor only advances after flushIndexedEvents succeeds, and
 *      is not rolled back to the pre-cycle cursor at the end of the cycle.
 */

process.env.NODE_ENV = 'test';
process.env.METRICS_PORT = '0';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-service-secret-value';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(32);

import test from 'tape';
import { xdr } from '@stellar/stellar-sdk';
import type { PollLeaderLockClient } from './index.js';

const { POLL_LEADER_LOCK_KEY, runPollCycle } = await import('./index.js');

function createInMemoryLockRedis(): PollLeaderLockClient & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value, _px, _ttl, nx) {
      if (nx === 'NX' && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    },
    async eval(_script, _numkeys, key, expectedToken) {
      const k = String(key);
      const token = String(expectedToken);
      if (store.get(k) === token) {
        store.delete(k);
        return 1;
      }
      return 0;
    },
  };
}

function makeMockRpcEvent(id: string, ledger: number) {
  return {
    id,
    ledger,
    topic: ['CustomContractEvent'],
    value: xdr.ScVal.scvString('ok'),
    contractId: 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO',
  };
}

test('#1057: only one indexer replica polls events at a time under the Redis leader lock', async (t) => {
  const redis = createInMemoryLockRedis();
  let activePolls = 0;
  let maxConcurrentPolls = 0;
  let totalGetEventsCalls = 0;

  let releaseReplica1Rpc!: () => void;
  const replica1InFlight = new Promise<void>((resolve) => {
    releaseReplica1Rpc = resolve;
  });

  const rpcServer = {
    getLatestLedger: async () => ({ sequence: 5000 }) as any,
    getEvents: async () => {
      totalGetEventsCalls++;
      activePolls++;
      maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
      await replica1InFlight;
      activePolls--;
      return { events: [] } as any;
    },
  };

  let cursor: number | undefined = 5000;
  let latestSeq: number | undefined = 5000;

  // Start replica 1 (acquires lock and pauses inside getEvents)
  const replica1Promise = runPollCycle({
    redis,
    rpcServer,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    getLatestSequence: () => latestSeq,
    setLatestSequence: (s) => {
      latestSeq = s;
    },
    flushEvents: async () => ({ inserted: 0, maxInsertedLedger: null }),
    dispatchWebhooks: async () => {},
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  t.equal(redis.store.has(POLL_LEADER_LOCK_KEY), true, 'leader lock is held while replica 1 polls');

  // Replica 2 runs concurrently while replica 1 holds the lock
  await runPollCycle({
    redis,
    rpcServer,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    getLatestSequence: () => latestSeq,
    setLatestSequence: (s) => {
      latestSeq = s;
    },
    flushEvents: async () => ({ inserted: 0, maxInsertedLedger: null }),
    dispatchWebhooks: async () => {},
  });

  t.equal(totalGetEventsCalls, 1, 'replica 2 skipped polling because replica 1 holds the leader lock');
  t.equal(maxConcurrentPolls, 1, 'never more than one active poll cycle');

  releaseReplica1Rpc();
  await replica1Promise;

  t.equal(redis.store.has(POLL_LEADER_LOCK_KEY), false, 'leader lock is released after cycle finishes');
  t.end();
});

test('#1057: missing/null cursor fetches latest ledger from RPC instead of falling back to 0', async (t) => {
  const redis = createInMemoryLockRedis();
  const requestedStartLedgers: number[] = [];

  let cursor: number | null | undefined = null;
  let latestSeq: number | undefined = undefined;

  const rpcServer = {
    getLatestLedger: async () => ({ sequence: 42_100 }) as any,
    getEvents: async (args: { startLedger: number }) => {
      requestedStartLedgers.push(args.startLedger);
      return { events: [] } as any;
    },
  };

  await runPollCycle({
    redis,
    rpcServer,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    getLatestSequence: () => latestSeq,
    setLatestSequence: (s) => {
      latestSeq = s;
    },
    getIndexFromLedger: () => undefined,
    flushEvents: async () => ({ inserted: 0, maxInsertedLedger: null }),
    dispatchWebhooks: async () => {},
  });

  t.deepEqual(requestedStartLedgers, [42_100], 'getEvents called with RPC tip sequence (42100), never 0');
  t.equal(cursor, 42_100, 'cursor initialized to RPC tip after successful poll');
  t.end();
});

test('#1057: missing cursor skips getEvents entirely when RPC tip and INDEX_FROM_LEDGER are unavailable (never uses 0)', async (t) => {
  const redis = createInMemoryLockRedis();
  let getEventsCalled = false;

  const rpcServer = {
    getLatestLedger: async () => {
      throw new Error('RPC unreachable');
    },
    getEvents: async () => {
      getEventsCalled = true;
      return { events: [] } as any;
    },
  };

  await runPollCycle({
    redis,
    rpcServer,
    getCursor: () => undefined,
    setCursor: () => {},
    getLatestSequence: () => undefined,
    setLatestSequence: () => {},
    getIndexFromLedger: () => undefined,
    flushEvents: async () => ({ inserted: 0, maxInsertedLedger: null }),
    dispatchWebhooks: async () => {},
  });

  t.equal(getEventsCalled, false, 'getEvents is not called when cursor cannot be resolved');
  t.end();
});

test('#1057: DB flush failure does not advance latestLedgerCursor, and commit advances it to maxInsertedLedger + 1', async (t) => {
  const redis = createInMemoryLockRedis();
  let cursor: number | undefined = 1000;
  let latestSeq: number | undefined = 1005;
  let shouldFailFlush = true;

  const rpcServer = {
    getLatestLedger: async () => ({ sequence: 1005 }) as any,
    getEvents: async () =>
      ({
        events: [
          makeMockRpcEvent('evt_1000', 1000),
          makeMockRpcEvent('evt_1001', 1001),
        ],
      }) as any,
  };

  // Cycle 1: flushIndexedEvents fails with a DB error
  await runPollCycle({
    redis,
    rpcServer,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    getLatestSequence: () => latestSeq,
    setLatestSequence: (s) => {
      latestSeq = s;
    },
    flushEvents: async () => {
      if (shouldFailFlush) {
        throw new Error('Prisma connection pool timeout');
      }
      return { inserted: 2, maxInsertedLedger: 1001 };
    },
    dispatchWebhooks: async () => {},
  });

  t.equal(cursor, 1000, 'latestLedgerCursor remains at 1000 when flushIndexedEvents fails');
  t.equal(redis.store.has(POLL_LEADER_LOCK_KEY), false, 'leader lock is still released after DB flush failure');

  // Cycle 2: flushIndexedEvents succeeds
  shouldFailFlush = false;
  await runPollCycle({
    redis,
    rpcServer,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    getLatestSequence: () => latestSeq,
    setLatestSequence: (s) => {
      latestSeq = s;
    },
    flushEvents: async () => ({ inserted: 2, maxInsertedLedger: 1001 }),
    dispatchWebhooks: async () => {},
  });

  t.equal(cursor, 1002, 'latestLedgerCursor advances to maxInsertedLedger + 1 (1002) after flush commits');
  t.end();
});

test.onFinish(() => {
  process.exit(0);
});
