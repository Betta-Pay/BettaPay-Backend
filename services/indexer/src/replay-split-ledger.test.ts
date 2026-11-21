/**
 * Issue #1054 — Fix split-ledger event skipping in indexer replayWorker.
 *
 * Simulates a high-volume ledger containing > REPLAY_CHUNK_SIZE events and
 * verifies that cursor pagination replays every event in the split ledger
 * without skipping, and advances deterministically across chunks.
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

const { prisma, runReplayJob } = await import('./index.js');

const CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';

function makeMockEvent(id: string, ledger: number) {
  return {
    id,
    ledger,
    topic: ['CustomEvent'],
    value: xdr.ScVal.scvU32(1),
    contractId: { toString: () => CONTRACT_ID },
  };
}

test('#1054: runReplayJob paginates within a high-volume ledger exceeding chunkSize without skipping events', async (t) => {
  const originalFindMany = prisma.indexedEvent.findMany;
  const originalCreate = prisma.indexedEvent.create;

  const CHUNK_SIZE = 100;
  // 250 events in ledger 500 (> REPLAY_CHUNK_SIZE=100), plus 25 events in ledger 501
  const ledger500Events = Array.from({ length: 250 }, (_, i) =>
    makeMockEvent(`evt-500-${i}`, 500),
  );
  const ledger501Events = Array.from({ length: 25 }, (_, i) =>
    makeMockEvent(`evt-501-${i}`, 501),
  );
  const allEvents = [...ledger500Events, ...ledger501Events];

  const getEventsRequests: Array<{ startLedger?: number; cursor?: string; limit?: number }> = [];
  const persistedStellarIds: string[] = [];

  prisma.indexedEvent.findMany = (async () => []) as any;
  prisma.indexedEvent.create = (async ({ data }: any) => {
    persistedStellarIds.push(data.stellarId);
    return data;
  }) as any;

  const mockRpcServer = {
    async getEvents(req: { startLedger?: number; cursor?: string; limit?: number }) {
      getEventsRequests.push({
        startLedger: req.startLedger,
        cursor: req.cursor,
        limit: req.limit,
      });

      const limit = req.limit ?? CHUNK_SIZE;
      let startIndex = 0;

      if (req.cursor) {
        startIndex = Number(req.cursor.replace('cursor-', ''));
      } else if (req.startLedger !== undefined) {
        startIndex = allEvents.findIndex((e) => e.ledger >= req.startLedger!);
        if (startIndex === -1) {
          return { events: [], cursor: '', latestLedger: 501 };
        }
      }

      const slice = allEvents.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + slice.length;
      return {
        events: slice as any,
        cursor: `cursor-${nextIndex}`,
        latestLedger: 501,
      };
    },
  };

  try {
    await runReplayJob(
      'replay-test-1054',
      {
        fromLedger: 500,
        toLedger: 501,
        contractId: CONTRACT_ID,
        force: false,
      },
      {
        rpcServer: mockRpcServer as any,
        chunkSize: CHUNK_SIZE,
      },
    );

    t.equal(
      persistedStellarIds.length,
      275,
      'all 250 events in ledger 500 and 25 events in ledger 501 are replayed without gaps',
    );
    t.equal(persistedStellarIds[0], 'evt-500-0', 'first event in ledger 500 replayed');
    t.equal(persistedStellarIds[100], 'evt-500-100', '101st event in split ledger 500 is not skipped');
    t.equal(persistedStellarIds[249], 'evt-500-249', 'last event in split ledger 500 replayed');
    t.equal(persistedStellarIds[250], 'evt-501-0', 'first event in ledger 501 replayed');

    t.deepEqual(
      getEventsRequests.map((r) => ({ startLedger: r.startLedger, cursor: r.cursor })),
      [
        { startLedger: 500, cursor: undefined },
        { startLedger: undefined, cursor: 'cursor-100' },
        { startLedger: undefined, cursor: 'cursor-200' },
      ],
      'first request uses startLedger and subsequent chunks advance deterministically via RPC cursor',
    );
  } finally {
    prisma.indexedEvent.findMany = originalFindMany;
    prisma.indexedEvent.create = originalCreate;
  }

  t.end();
});
