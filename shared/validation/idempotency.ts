/**
 * idempotency.ts (#764)
 *
 * Canonical idempotency primitive for future endpoints. Three dialects exist
 * today and each covers only part of the race window:
 *
 * - gateway check-then-create: DB lookup by idempotency key (with expiry),
 *   then create. Closes the retry case but not the concurrent-race case.
 * - settlement NX+P2002: Redis `SET NX` claim, then create guarded by the DB
 *   `@unique` constraint (P2002 maps the loser back to the winner).
 * - bulk hash: payload hash stored under the key so the same key with a
 *   *different* payload is a 409 instead of a silent replay.
 *
 * {@link withIdempotency} composes all three stages — lookup, Redis claim,
 * guarded create — behind injectable dependencies so it can be unit-tested
 * without Redis or Prisma. It migrates zero existing call sites; it is a pure
 * addition for future endpoints.
 */

/** Minimal Redis surface used by {@link withIdempotency}. */
export interface IdempotencyRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<string | null>;
}

export type IdempotencySource =
  | "created"
  | "lookup-hit"
  | "redis-race"
  | "p2002-winner";

export interface WithIdempotencyResult<T> {
  result: T;
  /** `true` when an existing record/response was returned instead of creating. */
  deduped: boolean;
  source: IdempotencySource;
}

/** Thrown when a key is already claimed for a different payload or is still in flight. */
export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key is already in use") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export interface WithIdempotencyOptions<T> {
  /**
   * Client-supplied idempotency key. When absent (`undefined`/`null`/empty),
   * the helper skips every guard and just runs `create`.
   */
  key?: string | null;
  /** Redis client (or fake). When absent, the Redis-claim stage is skipped. */
  redis?: IdempotencyRedis | null;
  /** Prefix for the Redis claim key. Defaults to `"idempotency:"`. */
  redisKeyPrefix?: string;
  /** TTL for the Redis claim, in seconds. Defaults to 86400 (24 h). */
  redisTtlSeconds?: number;
  /**
   * Value stored by the Redis `SET NX` claim. Defaults to
   * `payloadHash ?? key`. Callers using the settlement dialect pass the new
   * record id so the loser can resolve the winner from the claim value.
   */
  claimValue?: string;
  /**
   * Bulk-hash dialect: hash of the request payload. When the Redis claim is
   * lost and the stored hash differs from this value, an
   * {@link IdempotencyConflictError} is thrown (same key, different payload)
   * instead of replaying another request's response.
   */
  payloadHash?: string | null;
  /** DB lookup for a non-expired record under `key` (gateway dialect). */
  lookupExisting?: (key: string) => Promise<T | null>;
  /**
   * Resolves the race winner from the stored Redis claim value (settlement
   * dialect: claim value is the winner's record id).
   */
  resolveClaim?: (storedValue: string) => Promise<T | null>;
  /** Creates the record/response. Guarded by the P2002 winner lookup. */
  create: () => Promise<T>;
  /**
   * Detects the DB unique-violation that means a concurrent writer won.
   * Defaults to checking `err.code === "P2002"` (Prisma).
   */
  isUniqueViolation?: (err: unknown) => boolean;
}

const DEFAULT_PREFIX = "idempotency:";
const DEFAULT_TTL_SECONDS = 86400;

function defaultIsUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Runs `create` under the canonical idempotency stages:
 *
 * 1. **lookup-hit** — `lookupExisting(key)` returns a live record; return it
 *    without creating.
 * 2. **Redis claim** — `SET claimKey value EX ttl NX`. A `null` reply means a
 *    concurrent request claimed first; resolve the winner via `resolveClaim`
 *    (then `lookupExisting`) and return it as `redis-race`. A Redis *error*
 *    is treated as Redis-down: fall through to the DB-guarded create so a
 *    cache outage never blocks writes (the `@unique` constraint remains the
 *    backstop).
 * 3. **guarded create** — run `create()`. On a unique violation (P2002),
 *    re-run `lookupExisting(key)` and return the winner as `p2002-winner`.
 *
 * With no `key`, all guards are skipped and `create()` runs directly.
 */
export async function withIdempotency<T>(
  options: WithIdempotencyOptions<T>,
): Promise<WithIdempotencyResult<T>> {
  const {
    redis = null,
    redisKeyPrefix = DEFAULT_PREFIX,
    redisTtlSeconds = DEFAULT_TTL_SECONDS,
    claimValue,
    payloadHash = null,
    lookupExisting,
    resolveClaim,
    create,
    isUniqueViolation = defaultIsUniqueViolation,
  } = options;
  const rawKey = options.key;
  const key =
    typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;

  if (!key) {
    return { result: await create(), deduped: false, source: "created" };
  }

  // Stage 1 — gateway check-then-create dialect.
  if (lookupExisting) {
    const existing = await lookupExisting(key);
    if (existing !== null && existing !== undefined) {
      return { result: existing, deduped: true, source: "lookup-hit" };
    }
  }

  // Stage 2 — settlement NX-claim dialect (with bulk-hash comparison).
  if (redis) {
    const claimKey = `${redisKeyPrefix}${key}`;
    const value = claimValue ?? payloadHash ?? key;
    try {
      const claimed = await redis.set(
        claimKey,
        value,
        "EX",
        redisTtlSeconds,
        "NX",
      );
      if (claimed === null) {
        const stored = await redis.get(claimKey).catch(() => null);
        if (
          payloadHash !== null &&
          stored !== null &&
          stored !== payloadHash
        ) {
          throw new IdempotencyConflictError(
            "Idempotency key already used with a different payload",
          );
        }
        if (stored !== null && resolveClaim) {
          const winner = await resolveClaim(stored);
          if (winner !== null && winner !== undefined) {
            return { result: winner, deduped: true, source: "redis-race" };
          }
        }
        if (lookupExisting) {
          const winner = await lookupExisting(key);
          if (winner !== null && winner !== undefined) {
            return { result: winner, deduped: true, source: "redis-race" };
          }
        }
        throw new IdempotencyConflictError(
          "Idempotency key is currently being processed",
        );
      }
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw err;
      // Redis-down fallback: continue to the DB-guarded create. The @unique
      // constraint on the idempotency column remains the correctness backstop.
    }
  }

  // Stage 3 — guarded create with P2002-winner resolution.
  try {
    return { result: await create(), deduped: false, source: "created" };
  } catch (err) {
    if (isUniqueViolation(err) && lookupExisting) {
      const winner = await lookupExisting(key);
      if (winner !== null && winner !== undefined) {
        return { result: winner, deduped: true, source: "p2002-winner" };
      }
    }
    throw err;
  }
}
