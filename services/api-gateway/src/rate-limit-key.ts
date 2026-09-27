/**
 * Two-dimensional rate-limit keying (Issue #559).
 *
 * Rate limits used to fall back to @fastify/rate-limit's default key, the
 * client IP. Every merchant behind one NAT — a corporate egress, a shared
 * PaaS runtime, a mobile carrier gateway — therefore drew from a single
 * bucket, so one noisy merchant could throttle everyone sharing its address.
 *
 * Keys now carry two dimensions:
 *
 *   merchant  the authenticated merchant, when the request carries a valid
 *             bearer token. This is the primary bucket: merchants are
 *             isolated from each other regardless of the address they
 *             share.
 *   ip        the client address. It is the bucket for anonymous traffic,
 *             and the nested ceiling that still applies to authenticated
 *             traffic so a single address cannot multiply its allowance by
 *             minting merchant tokens.
 *
 * Prefixes keep the two namespaces apart: a merchant whose id happens to
 * read like an address can never collide with that address's bucket.
 */

export const MERCHANT_KEY_PREFIX = "m:";
export const IP_KEY_PREFIX = "ip:";

export type RateLimitDimension = "merchant" | "ip";

export interface RateLimitIdentity {
  /** Which dimension owns the primary bucket for this request. */
  dimension: RateLimitDimension;
  /** Authenticated merchant id, or null for anonymous traffic. */
  merchantId: string | null;
  /** Client address, always present — it backs the nested ceiling. */
  ip: string;
}

/**
 * Normalize an IP address for rate limiting (#619).
 *
 * - Strips IPv6-mapped IPv4 prefix (::ffff:) so 1.2.3.4 and ::ffff:1.2.3.4 map to the same key
 * - Converts to lowercase for consistent comparison
 * - Removes zone IDs (e.g., %lo0, %eth0) that pollute the key
 *
 * @param ip - Raw IP address from request
 * @returns Normalized IP address
 *
 * @example
 *   normalizeIp('::ffff:192.168.1.1') // '192.168.1.1'
 *   normalizeIp('2001:DB8::1%lo0')   // '2001:db8::1'
 *   normalizeIp('192.168.1.1')       // '192.168.1.1'
 */
export function normalizeIp(ip: string): string {
  let normalized = ip.trim().toLowerCase();

  // Strip IPv6-mapped IPv4 prefix
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice(7);
  }

  // Remove zone ID (e.g., %lo0, %eth0)
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  return normalized;
}

/**
 * Client address as seen through a proxy.
 *
 * Mirrors the gateway's existing auth-reputation IP extraction so a client
 * is the same "who" to the rate limiter as it is to the IP-reputation
 * scorer: leftmost X-Forwarded-For entry, else the socket address.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  socketIp: string,
): string {
  const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (value) {
    const first = value.split(",")[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(socketIp);
}

/**
 * Read a merchant id out of a bearer token.
 *
 * The signature is verified — an unverified payload would let any caller
 * claim another merchant's bucket, or evade its own by inventing ids. Any
 * failure (missing header, malformed token, bad signature, expired token,
 * payload without a merchant id) yields null, and the caller falls back to
 * the IP dimension.
 *
 * `verify` is injected so this stays a pure function of its inputs.
 */
export function extractMerchantId(
  authorization: string | undefined,
  verify: (token: string) => unknown,
): string | null {
  if (!authorization) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) return null;

  let payload: unknown;
  try {
    payload = verify(match[1]);
  } catch {
    return null;
  }

  const merchantId = (payload as { merchantId?: unknown } | null)?.merchantId;
  if (typeof merchantId !== "string" || merchantId.length === 0) return null;

  return merchantId;
}

/**
 * Decide which dimension owns a request's primary bucket.
 *
 * An authenticated request is keyed by its merchant; anything else by its
 * address.
 */
export function resolveRateLimitIdentity(input: {
  merchantId: string | null | undefined;
  ip: string;
}): RateLimitIdentity {
  const merchantId =
    typeof input.merchantId === "string" && input.merchantId.length > 0
      ? input.merchantId
      : null;

  return {
    dimension: merchantId ? "merchant" : "ip",
    merchantId,
    ip: input.ip,
  };
}

/** Primary bucket key: per merchant when authenticated, per IP otherwise. */
export function buildRateLimitKey(identity: RateLimitIdentity): string {
  return identity.dimension === "merchant"
    ? `${MERCHANT_KEY_PREFIX}${identity.merchantId}`
    : `${IP_KEY_PREFIX}${identity.ip}`;
}

/** Nested bucket key: the address dimension, whoever the caller is. */
export function buildIpRateLimitKey(identity: RateLimitIdentity): string {
  return `${IP_KEY_PREFIX}${identity.ip}`;
}

/**
 * Whether the nested per-IP ceiling still needs checking.
 *
 * Anonymous requests are already counted in the IP bucket by the primary
 * key, so re-checking them would double-count the same request.
 */
export function needsNestedIpLimit(identity: RateLimitIdentity): boolean {
  return identity.dimension === "merchant";
}

/** The subset of a Fastify request the identity resolution needs. */
export interface RateLimitRequestLike {
  headers: {
    authorization?: string;
    "x-forwarded-for"?: string | string[];
  };
  ip: string;
  /** Populated once route authentication has run. */
  user?: { merchantId?: unknown } | null;
  /** Memoization slot, so one request resolves one identity. */
  rateLimitIdentity?: RateLimitIdentity;
}

/**
 * Resolve — and memoize — a request's rate-limit identity.
 *
 * The identity is derived from the bearer token rather than from
 * `request.user`, because the limiter runs in `onRequest`, before the routes'
 * `preValidation` authentication. When authentication has already run (the
 * response-header mirror, for instance) its verified merchant id is preferred.
 *
 * Memoizing on the request keeps the primary bucket, the nested per-IP
 * ceiling and the header mirror in agreement, and verifies each token once.
 */
export function rateLimitIdentityOf(
  request: RateLimitRequestLike,
  verify: (token: string) => unknown,
): RateLimitIdentity {
  if (request.rateLimitIdentity) return request.rateLimitIdentity;

  const authenticated = request.user?.merchantId;
  const merchantId =
    typeof authenticated === "string" && authenticated.length > 0
      ? authenticated
      : extractMerchantId(request.headers.authorization, verify);

  const identity = resolveRateLimitIdentity({
    merchantId,
    ip: resolveClientIp(request.headers["x-forwarded-for"], request.ip),
  });

  request.rateLimitIdentity = identity;
  return identity;
}
