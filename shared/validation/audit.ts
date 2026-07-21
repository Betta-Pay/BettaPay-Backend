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
  user?: Record<string, unknown> | null;
}

function getRequestIp(request?: AuditLogRequestLike | null): string | null {
  if (!request) return null;

  const forwardedFor = request.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string') {
    const [first] = forwardedFor.split(',');
    return first?.trim() || null;
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return String(forwardedFor[0]).trim() || null;
  }

  const realIp = request.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return request.ip ?? null;
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
