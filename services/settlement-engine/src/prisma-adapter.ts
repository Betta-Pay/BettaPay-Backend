// @ts-nocheck
/**
 * Prisma adapter helpers for the settlement engine (#543).
 *
 * These helpers replace raw `prisma.settlement.upsert` / unconditional `update`
 * calls with a concurrency-safe pattern:
 *
 *   - Creation uses `create` and relies on the `@unique` constraints on
 *     `id` and `idempotencyKey` as the database-level race guard. A P2002
 *     unique-constraint violation is translated into a deterministic lookup
 *     of the existing record.
 *   - Updates use an optimistic lock on `version`. The caller must supply the
 *     version it read; the update only succeeds if the row still has that
 *     version, and the helper atomically increments it. A stale version
 *     produces a `VersionConflictError` instead of silently overwriting a
 *     concurrent writer.
 */

import type { PrismaClient, Prisma, Settlement } from '@prisma/client';

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export class VersionConflictError extends Error {
  constructor(
    public readonly entityType: string,
    public readonly entityId: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Version conflict on ${entityType} ${entityId}: expected version ${expectedVersion}`,
    );
    this.name = 'VersionConflictError';
  }
}

export class UniqueConstraintError extends Error {
  constructor(
    message = 'Unique constraint violation while creating settlement',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UniqueConstraintError';
  }
}

export type CreateSettlementInput = Prisma.SettlementCreateInput;

/**
 * Create a settlement using `create` (not `upsert`) and handle the unique
 * constraints on `id` and `idempotencyKey` as a concurrency guard.
 *
 * If the create fails with Prisma error P2002, we re-query the existing
 * record by its unique identifier so the caller can return the same entity
 * to both winning and losing racers.
 */
export async function createSettlementWithUniqueGuard(
  prisma: PrismaLike,
  data: CreateSettlementInput,
): Promise<Settlement> {
  try {
    return await prisma.settlement.create({ data });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // A concurrent request won the race. Return the existing settlement
      // keyed by id or idempotencyKey, whichever is present in the payload.
      const existingById = data.id
        ? await prisma.settlement.findUnique({ where: { id: data.id as string } })
        : null;
      if (existingById) return existingById;

      const idempotencyKey =
        typeof data.idempotencyKey === 'string' ? data.idempotencyKey : undefined;
      if (idempotencyKey) {
        const existingByKey = await prisma.settlement.findUnique({
          where: { idempotencyKey },
        });
        if (existingByKey) return existingByKey;
      }

      throw new UniqueConstraintError(
        'Settlement unique constraint violated but existing record not found',
        err,
      );
    }
    throw err;
  }
}

/**
 * Update a settlement with an optimistic version check.
 *
 * The update only succeeds if the current `version` equals `expectedVersion`.
 * On success, `version` is atomically incremented by 1. On mismatch, a
 * `VersionConflictError` is thrown so callers can reject the request or
 * retry with fresh state.
 */
export async function updateSettlementWithOptimisticLock<
  T extends Prisma.SettlementUpdateInput,
>(
  prisma: PrismaLike,
  {
    id,
    expectedVersion,
    data,
  }: {
    id: string;
    expectedVersion: number;
    data: T;
  },
): Promise<Settlement> {
  const result = await prisma.settlement.updateMany({
    where: { id, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });

  if (result.count === 0) {
    throw new VersionConflictError('Settlement', id, expectedVersion);
  }

  const updated = await prisma.settlement.findUnique({ where: { id } });
  if (!updated) {
    throw new VersionConflictError('Settlement', id, expectedVersion);
  }

  return updated;
}
