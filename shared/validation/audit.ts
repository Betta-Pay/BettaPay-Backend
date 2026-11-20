import type { FastifyRequest } from 'fastify';

export interface AuditLogPrismaWriteClient {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface AuditLogLogger {
  warn?: (obj: object, msg?: string) => void;
}

export interface AuditLogRequestLike {
  headers?: Record<string, unknown>;
  ip?: string | null;
  // Fastify JWT decorates `user` as string | object | Buffer — narrow at use sites.
  user?: unknown;
}

export function parseTrustedProxyCount(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Split an X-Forwarded-For value (string or repeated header) into trimmed, non-empty hops. */
function parseForwardedFor(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
}

/** First non-empty value of a single-address header such as X-Real-IP. */
function parseRealIp(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return '';
  // X-Real-IP should carry one address; tolerate a misconfigured proxy that
  // sends a list by taking the first entry rather than the whole string.
  return raw.split(',')[0].trim();
}

/**
 * Extract the real client IP from a request, honoring a configured number of
 * trusted reverse-proxy hops (#621, #1073).
 *
 * X-Forwarded-For (and X-Real-IP) are entirely attacker-controlled unless
 * something in front of this process is known to overwrite/append to them
 * honestly. With trustedProxyCount = 0 (the default), neither header is
 * consulted — the request's own transport-layer address (request.ip) is
 * used, which the client cannot spoof. With trustedProxyCount = N:
 *
 *  1. X-Forwarded-For — the chain is combined with request.ip into one hop
 *     list [xff-entries..., request.ip] and the client is taken to be the
 *     entry N positions in from the right, mirroring Express's/Fastify's
 *     `trust proxy: N` semantics. A chain shorter than N (e.g. a single-entry
 *     header behind 2 configured proxies) resolves to its leftmost entry —
 *     the furthest hop any proxy reported — rather than an out-of-range index.
 *  2. X-Real-IP — used when X-Forwarded-For is absent or contains no usable
 *     entries (e.g. nginx `proxy_set_header X-Real-IP $remote_addr` only).
 *  3. request.ip — the transport-layer peer address.
 *
 * Always returns a string; an empty string means no address was available.
 */
export function getClientIp(
  request: AuditLogRequestLike,
  trustedProxyCount: number = parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT),
): string {
  const peerIp = typeof request.ip === 'string' ? request.ip.trim() : '';
  if (trustedProxyCount <= 0) return peerIp;

  const realIp = parseRealIp(request.headers?.['x-real-ip']);
  const hops = parseForwardedFor(request.headers?.['x-forwarded-for']);

  if (hops.length > 0) {
    // The peer slot is kept even when request.ip is unknown so the trusted-hop
    // count still lines up with the proxies that appended to the chain.
    const chain = [...hops, peerIp];
    const clientIndex = Math.max(0, chain.length - 1 - trustedProxyCount);
    const candidate = chain[clientIndex];
    if (candidate) return candidate;
  }

  return realIp || peerIp;
}

function getRequestIp(request?: AuditLogRequestLike | null): string | null {
  if (!request) return null;
  return getClientIp(request) || null;
}

function getActorFromRequest(request?: AuditLogRequestLike | null): {
  actorId: string | null;
  actorType: string | null;
} {
  const user = request?.user as Record<string, unknown> | undefined;
  const candidateId =
    (user?.sub as string | undefined) ??
    (user?.id as string | undefined) ??
    (user?.merchantId as string | undefined) ??
    (user?.ownerId as string | undefined);

  if (candidateId) {
    return {
      actorId: candidateId,
      actorType: (user?.type as string | undefined) ?? (user?.actorType as string | undefined) ?? 'user',
    };
  }

  const serviceToken = request?.headers?.['x-service-token'];
  if (typeof serviceToken === 'string' || Array.isArray(serviceToken)) {
    return { actorId: 'service', actorType: 'service' };
  }

  return { actorId: null, actorType: null };
}

const SENSITIVE_AUDIT_KEYS = new Set([
  'secret',
  'signingsecret',
  'signing_secret',
  'password',
  'token',
]);

function isSensitiveAuditKey(key: string): boolean {
  return SENSITIVE_AUDIT_KEYS.has(key.toLowerCase());
}

function redactSensitiveAudit(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveAudit(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveAuditKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveAudit(val);
    }
  }
  return result;
}

function bigintJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export function serializeChanges(changes: unknown): Record<string, unknown> | null {
  if (changes === undefined || changes === null) return null;

  if (typeof changes === 'bigint') {
    return { value: changes.toString() };
  }

  if (typeof changes === 'object') {
    const redacted = redactSensitiveAudit(changes);
    return JSON.parse(JSON.stringify(redacted, bigintJsonReplacer)) as Record<string, unknown>;
  }

  return { value: changes };
}

export function createAuditLogger(
  defaultPrisma: AuditLogPrismaWriteClient,
  logger?: AuditLogLogger,
) {
  return async function logAuditEvent(
    action: string,
    entityType: string,
    entityId: string,
    changes: unknown,
    request?: AuditLogRequestLike | null,
    prismaClient: AuditLogPrismaWriteClient = defaultPrisma,
  ): Promise<void> {
    try {
      const { actorId, actorType } = getActorFromRequest(request);
      await prismaClient.auditLog.create({
        data: {
          action,
          entityType,
          entityId,
          actorId,
          actorType,
          changes: serializeChanges(changes) ?? {},
          ipAddress: getRequestIp(request),
          createdAt: new Date(),
        },
      });
    } catch (error) {
      logger?.warn?.(
        { err: error, action, entityType, entityId },
        'Audit logging failed',
      );
    }
  };
}

export type AuditLogRequest = FastifyRequest;
