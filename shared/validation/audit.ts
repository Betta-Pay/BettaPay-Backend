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

function parseTrustedProxyCount(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Extract the real client IP from a request, honoring a configured number of
 * trusted reverse-proxy hops (#621).
 *
 * X-Forwarded-For (and X-Real-IP) are entirely attacker-controlled unless
 * something in front of this process is known to overwrite/append to them
 * honestly. With trustedProxyCount = 0 (the default), neither header is
 * consulted — the request's own transport-layer address (request.ip) is
 * used, which the client cannot spoof. With trustedProxyCount = N, the
 * X-Forwarded-For chain is combined with request.ip into one hop list
 * [xff-entries..., request.ip] and the client is taken to be the entry N
 * positions in from the right — i.e. the entries a chain of N trusted
 * proxies would have appended are stripped off, mirroring Express's/
 * Fastify's `trust proxy: N` semantics.
 */
export function getClientIp(
  request: AuditLogRequestLike,
  trustedProxyCount: number = parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT),
): string {
  const fallback = request.ip ?? '';
  if (trustedProxyCount <= 0) return fallback;

  const forwardedFor = request.headers?.['x-forwarded-for'];
  const rawForwardedFor = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;

  if (typeof rawForwardedFor === 'string' && rawForwardedFor.trim()) {
    const hops = rawForwardedFor
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    const chain = [...hops, fallback];
    const clientIndex = Math.max(0, chain.length - 1 - trustedProxyCount);
    return chain[clientIndex] || fallback;
  }

  const realIp = request.headers?.['x-real-ip'];
  const rawRealIp = Array.isArray(realIp) ? realIp[0] : realIp;
  if (typeof rawRealIp === 'string' && rawRealIp.trim()) {
    return rawRealIp.trim();
  }

  return fallback;
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

function serializeChanges(changes: unknown): Record<string, unknown> | null {
  if (changes === undefined || changes === null) return null;

  if (typeof changes === 'object') {
    return JSON.parse(JSON.stringify(changes)) as Record<string, unknown>;
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
