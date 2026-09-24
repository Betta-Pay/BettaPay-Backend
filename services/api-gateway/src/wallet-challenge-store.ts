/**
 * Server-side wallet auth challenge store (Issue #554 & #605).
 *
 * Challenges used to live in a per-process `Map`. Nothing ever evicted an
 * entry that was never verified, the store was invisible to every other
 * gateway instance, and a challenge survived every failed verification
 * attempt — so a signature could be guessed at indefinitely against a single
 * outstanding challenge.
 *
 * Challenges now live in Redis under a TTL, and verification *consumes* them:
 *
 *   - Redis expires the key on its own, so a stale challenge disappears even
 *     if nobody ever comes back for it.
 *   - `consume()` reads and deletes in one atomic operation, so a challenge
 *     is usable exactly once — whether the signature turns out to be valid or
 *     not.
 *   - The recorded `expiresAt` is re-checked against the server clock, so a
 *     key that outlives its deadline (clock skew, a TTL that has not been
 *     reaped yet, a restored snapshot) is still rejected rather than
 *     accepted.
 *
 * Issue #605: Two parallel implementations existed (wallet-challenge-store.ts
 * and wallet-auth-challenge.ts) with conflicting TTL values (5 min vs 2 min)
 * and different schema (presence/absence of nonce and address fields).
 * This consolidated version uses 2 minutes TTL and includes both nonce and
 * address in the stored record for audit trail and signature verification.
 */

import crypto from "crypto";

/** How long an issued challenge stays valid. */
export const WALLET_CHALLENGE_TTL_MS = 2 * 60 * 1000;

export const WALLET_CHALLENGE_KEY_PREFIX = "wallet_challenge:";

export interface StoredWalletChallenge {
  /** The exact string the wallet is expected to sign. */
  challenge: string;
  /** Raw nonce embedded in challenge for traceability. */
  nonce: string;
  /** Address the challenge was issued to — the binding. */
  address: string;
  /** Epoch ms when issued. */
  issuedAt: number;
  /** Epoch ms when the challenge stops being valid. */
  expiresAt: number;
}

export type ConsumeChallengeResult =
  | { status: "valid"; challenge: StoredWalletChallenge }
  /** No challenge outstanding: never issued, already used, or reaped by Redis. */
  | { status: "not_found" }
  /** Still stored, but past its deadline according to the server clock. */
  | { status: "expired" };

/** The Redis surface this store needs. */
export interface WalletChallengeRedis {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
  ): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string>): Promise<any>;
  del(key: string): Promise<unknown>;
}

export interface WalletChallengeStoreOptions {
  ttlMs?: number;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
}

export function walletChallengeKey(address: string): string {
  return `${WALLET_CHALLENGE_KEY_PREFIX}${address}`;
}

/**
 * Lua script for atomic consume (GET + DEL in one operation).
 * Ensures a challenge can only be used once, even under concurrent verify requests.
 */
const CONSUME_CHALLENGE_SCRIPT = `
  if redis.call("exists", KEYS[1]) == 1 then
    local v = redis.call("GET", KEYS[1])
    redis.call("DEL", KEYS[1])
    return v
  else
    return nil
  end
`;

export class WalletChallengeStore {
  private readonly redis: WalletChallengeRedis;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    redis: WalletChallengeRedis,
    options: WalletChallengeStoreOptions = {},
  ) {
    this.redis = redis;
    this.ttlMs = options.ttlMs ?? WALLET_CHALLENGE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Issue a fresh challenge for an address, replacing any outstanding one.
   *
   * The key carries a Redis TTL matching the recorded deadline, so an
   * unclaimed challenge is reaped rather than accumulating forever.
   */
  async issue(address: string): Promise<StoredWalletChallenge> {
    const nonce = crypto.randomBytes(16).toString("hex");
    const issuedAt = this.now();
    const record: StoredWalletChallenge = {
      challenge: `${nonce}:${crypto.randomBytes(16).toString("hex")}`,
      nonce,
      address,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };

    await this.redis.set(
      walletChallengeKey(address),
      JSON.stringify(record),
      "PX",
      this.ttlMs,
    );

    return record;
  }

  /**
   * Atomically take an address's outstanding challenge.
   *
   * The read and the delete are one operation, so two concurrent
   * verifications cannot both claim the same challenge, and a caller that
   * fails verification does not get to retry against it.
   */
  async consume(address: string): Promise<ConsumeChallengeResult> {
    const key = walletChallengeKey(address);
    const raw = (await this.redis.eval(CONSUME_CHALLENGE_SCRIPT, 1, key)) as
      | string
      | null;
    if (!raw) return { status: "not_found" };

    let record: StoredWalletChallenge;
    try {
      record = JSON.parse(raw) as StoredWalletChallenge;
    } catch {
      // A corrupt record is no better than none; it is already deleted.
      return { status: "not_found" };
    }

    if (
      typeof record?.challenge !== "string" ||
      typeof record?.address !== "string" ||
      typeof record?.expiresAt !== "number"
    ) {
      return { status: "not_found" };
    }

    if (this.now() > record.expiresAt) {
      return { status: "expired" };
    }

    return { status: "valid", challenge: record };
  }

  /** Drop an address's outstanding challenge without consuming it. */
  async discard(address: string): Promise<void> {
    await this.redis.del(walletChallengeKey(address));
  }
}

