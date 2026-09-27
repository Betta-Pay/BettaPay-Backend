/**
 * batch-scan.test.ts (#765)
 *
 * Unit tests for the shared forEachBatch scan helper. Pure addition — no
 * call-site changes. Covers the acceptance criteria: empty set,
 * exact-multiple pages, and early termination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { forEachBatch } from "./batch-scan.js";

/** Builds an id-cursor fetcher over an in-memory dataset. */
function memoryFetcher<T extends { id: string }>(rows: T[]) {
  const calls: Array<{ cursor: string | undefined; limit: number }> = [];
  const fetchPage = async (cursor: string | undefined, limit: number) => {
    calls.push({ cursor, limit });
    const start = cursor === undefined ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
    const items = rows.slice(start, start + limit);
    return {
      items,
      nextCursor:
        items.length === limit && start + limit < rows.length
          ? items[items.length - 1].id
          : (items.length === limit ? items[items.length - 1].id : null),
    };
  };
  return { calls, fetchPage };
}

test("forEachBatch: empty set calls onBatch zero times", async () => {
  const { calls, fetchPage } = memoryFetcher<{ id: string }>([]);
  let handlerCalls = 0;

  const result = await forEachBatch({
    batchSize: 3,
    fetchPage,
    onBatch: () => {
      handlerCalls += 1;
    },
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(result, { batches: 0, itemsProcessed: 0, terminatedEarly: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cursor: undefined, limit: 3 });
});

test("forEachBatch: exact-multiple pages scan every row exactly once", async () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const { calls, fetchPage } = memoryFetcher(rows);
  const seen: string[][] = [];

  const result = await forEachBatch({
    batchSize: 3,
    fetchPage,
    onBatch: (items) => {
      seen.push(items.map((r) => r.id));
    },
  });

  assert.deepEqual(seen, [
    ["a", "b", "c"],
    ["d", "e", "f"],
  ]);
  assert.deepEqual(result, { batches: 2, itemsProcessed: 6, terminatedEarly: false });
  // Stable id ordering: each page resumes after the last-seen id.
  assert.deepEqual(
    calls.map((c) => c.cursor),
    [undefined, "c", "f"],
  );
});

test("forEachBatch: partial final page terminates without an extra fetch", async () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const { calls, fetchPage } = memoryFetcher(rows);
  const seen: string[][] = [];

  const result = await forEachBatch({
    batchSize: 3,
    fetchPage,
    onBatch: (items) => {
      seen.push(items.map((r) => r.id));
    },
  });

  assert.deepEqual(seen, [
    ["a", "b", "c"],
    ["d", "e"],
  ]);
  assert.deepEqual(result, { batches: 2, itemsProcessed: 5, terminatedEarly: false });
  assert.equal(calls.length, 2);
});

test("forEachBatch: early termination stops the scan when onBatch returns false", async () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => ({ id }));
  const { calls, fetchPage } = memoryFetcher(rows);
  const seen: string[][] = [];

  const result = await forEachBatch({
    batchSize: 3,
    fetchPage,
    onBatch: (items) => {
      seen.push(items.map((r) => r.id));
      return false;
    },
  });

  assert.deepEqual(seen, [["a", "b", "c"]]);
  assert.deepEqual(result, { batches: 1, itemsProcessed: 3, terminatedEarly: true });
  assert.equal(calls.length, 1);
});

test("forEachBatch: async onBatch returning false also terminates early", async () => {
  const rows = ["a", "b", "c", "d"].map((id) => ({ id }));
  const { fetchPage } = memoryFetcher(rows);

  const result = await forEachBatch({
    batchSize: 2,
    fetchPage,
    onBatch: async () => false,
  });

  assert.deepEqual(result, { batches: 1, itemsProcessed: 2, terminatedEarly: true });
});

test("forEachBatch: rejects a non-positive batchSize", async () => {
  await assert.rejects(
    () =>
      forEachBatch({
        batchSize: 0,
        fetchPage: async () => ({ items: [], nextCursor: null }),
        onBatch: () => {},
      }),
    /batchSize must be a positive integer/,
  );
});
