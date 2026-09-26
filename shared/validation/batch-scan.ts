/**
 * batch-scan.ts (#765)
 *
 * Shared chunked-scan primitive. Unbounded scans recur because each job
 * hand-rolls its own pagination; new code should use {@link forEachBatch} so
 * chunked scans are the default.
 *
 * This module is intentionally dependency-free (no Prisma/Redis imports) so it
 * can be unit-tested with in-memory fakes and reused from any service. It
 * migrates zero existing call sites — it is a pure addition.
 */

/** A single page returned by a `fetchPage` implementation. */
export interface BatchPage<T> {
  items: T[];
  /**
   * Opaque cursor for the next page. `undefined`/`null` means "no more pages".
   * When items carry a stable id, implementations should set this to the last
   * seen id (see the cursor contract on {@link forEachBatch}).
   */
  nextCursor?: string | null;
}

/**
 * Fetches one page of a scan.
 *
 * @param cursor Opaque cursor from the previous page (`undefined` for the
 * first page). When scanning id-keyed rows this is the last-seen id.
 * @param limit Maximum number of items to return (the batch size).
 */
export type BatchFetcher<T> = (
  cursor: string | undefined,
  limit: number,
) => Promise<BatchPage<T>>;

/**
 * Called once per non-empty batch.
 *
 * @returns Return `false` (or a promise of `false`) to stop the scan early;
 * any other return value (including `undefined`) continues to the next page.
 */
export type BatchHandler<T> = (
  items: T[],
  batchIndex: number,
) => void | boolean | Promise<void | boolean>;

export interface ForEachBatchOptions<T> {
  /** Fetches one page per invocation. */
  fetchPage: BatchFetcher<T>;
  /** Called once per non-empty batch. */
  onBatch: BatchHandler<T>;
  /** Number of items requested per page. Defaults to 100. Must be >= 1. */
  batchSize?: number;
  /** Cursor to resume from. Defaults to `undefined` (scan from the start). */
  initialCursor?: string;
  /** Hard cap on the number of batches (safety valve). Must be >= 1. */
  maxBatches?: number;
}

export interface ForEachBatchResult {
  /** Number of batches handed to `onBatch`. */
  batches: number;
  /** Total number of items handed to `onBatch`. */
  itemsProcessed: number;
  /** `true` when the scan stopped because `onBatch` returned `false`. */
  terminatedEarly: boolean;
}

/**
 * Iterates over a dataset in fixed-size chunks.
 *
 * Stable id ordering contract
 * ───────────────────────────
 * Correctness of a cursor scan depends on the *fetch* implementation, not on
 * this loop: `fetchPage` MUST return rows in a stable, gap-tolerant order —
 * ascending by a unique, immutable id (e.g. `ORDER BY id ASC` with
 * `WHERE id > cursor LIMIT n`) — and MUST set `nextCursor` to the last-seen
 * id while more rows may remain. OFFSET-based paging (`SKIP`/`OFFSET`) is
 * explicitly out of contract: rows inserted or deleted mid-scan shift offsets
 * and cause skipped or duplicated rows, which is exactly the unbounded-scan
 * failure mode this helper replaces.
 *
 * Termination: the scan stops when a page returns fewer items than the batch
 * size, when `nextCursor` is absent, when a page is empty, when `maxBatches`
 * is reached, or when `onBatch` returns `false` (early termination).
 *
 * @example
 * ```ts
 * await forEachBatch({
 *   batchSize: 500,
 *   fetchPage: async (cursor, limit) =>
 *     prisma.payment.findMany({
 *       where: { ...(cursor ? { id: { gt: cursor } } : {}) },
 *       orderBy: { id: "asc" },
 *       take: limit,
 *     }).then((items) => ({
 *       items,
 *       nextCursor: items.length === limit ? items[items.length - 1].id : null,
 *     })),
 *   onBatch: async (payments) => {
 *     await expireStaleKeys(payments);
 *   },
 * });
 * ```
 */
export async function forEachBatch<T>(
  options: ForEachBatchOptions<T>,
): Promise<ForEachBatchResult> {
  const { fetchPage, onBatch, initialCursor, maxBatches } = options;
  const batchSize = options.batchSize ?? 100;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(
      `forEachBatch: batchSize must be a positive integer (got ${String(batchSize)})`,
    );
  }
  if (
    maxBatches !== undefined &&
    (!Number.isInteger(maxBatches) || maxBatches < 1)
  ) {
    throw new Error(
      `forEachBatch: maxBatches must be a positive integer (got ${String(maxBatches)})`,
    );
  }

  let cursor: string | undefined = initialCursor;
  let batches = 0;
  let itemsProcessed = 0;
  let terminatedEarly = false;

  for (;;) {
    const page = await fetchPage(cursor, batchSize);
    const items = page?.items ?? [];

    if (items.length === 0) break;

    const decision = await onBatch(items, batches);
    batches += 1;
    itemsProcessed += items.length;

    if (decision === false) {
      terminatedEarly = true;
      break;
    }
    if (maxBatches !== undefined && batches >= maxBatches) break;
    // A short page means the dataset is exhausted even when the fetcher
    // omits nextCursor handling.
    if (items.length < batchSize) break;
    const next = page.nextCursor ?? undefined;
    if (next === undefined) break;
    cursor = next;
  }

  return { batches, itemsProcessed, terminatedEarly };
}
