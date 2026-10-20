/**
 * Pins the cascade behavior of the Settlement.supersededById self-relation (#852).
 *
 * `supersededById` links a superseded (old) settlement to the replacement that
 * supersedes it. The relation is declared with `onDelete: SetNull`, which means
 * deleting a replacement settlement must:
 *
 *   - NOT delete the retries that pointed at it (that would be Cascade), and
 *   - NOT leave them pointing at a row that no longer exists (an orphan).
 *
 * Instead their `supersededById` link is cleared, so the retries stay queryable
 * as standalone settlements. This test observes that behavior through Prisma
 * and verifies the database constraint itself, so it fails if the onDelete
 * policy ever changes (e.g. to Cascade, Restrict, or NoAction) without the
 * documentation being updated with it.
 *
 * Runs against DATABASE_URL (the CI test job provisions PostgreSQL); skipped
 * locally when no database is reachable so the rest of `pnpm test` can run.
 */
import test from 'tape';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const MERCHANT_ID = 'cascade-852-merchant';
const PARENT_ID = 'cascade-852-parent';
const CHILD_FIRST_ID = 'cascade-852-child-first';
const CHILD_SECOND_ID = 'cascade-852-child-second';

const SETTLEMENT_DEFAULTS = {
  merchantId: MERCHANT_ID,
  totalAmount: '100',
  grossAmount: '100',
  feeAmount: '1',
  netAmount: '99',
  feeBps: 100,
  asset: 'USDC',
};

function createTestPrismaClient() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return { prisma: new PrismaClient({ adapter }), pool };
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.settlement.deleteMany({ where: { merchantId: MERCHANT_ID } });
  await prisma.merchant.deleteMany({ where: { id: MERCHANT_ID } });
}

test('Settlement.supersededById keeps retries on parent delete (onDelete: SetNull) (#852)', async (t) => {
  const { prisma, pool } = createTestPrismaClient();

  try {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = `PostgreSQL unreachable at ${process.env.DATABASE_URL ?? '<unset DATABASE_URL>'}: ${(error as Error).message}`;
      if (process.env.CI) {
        t.fail(message);
      } else {
        console.warn(`[settlement-cascade] skipping: ${message}`);
      }
      return;
    }

    await cleanup(prisma);
    await prisma.merchant.create({
      data: { id: MERCHANT_ID, name: 'Cascade test merchant', ownerId: 'owner-852' },
    });

    // The "parent" is the replacement settlement; the two children are older
    // settlements that were superseded by it.
    const parent = await prisma.settlement.create({
      data: { ...SETTLEMENT_DEFAULTS, id: PARENT_ID, status: 'pending' },
    });
    await prisma.settlement.create({
      data: { ...SETTLEMENT_DEFAULTS, id: CHILD_FIRST_ID, status: 'failed', supersededById: parent.id },
    });
    await prisma.settlement.create({
      data: { ...SETTLEMENT_DEFAULTS, id: CHILD_SECOND_ID, status: 'failed', supersededById: parent.id },
    });

    // The documented policy (schema comment and relation) matches reality…
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    t.match(
      schema,
      /supersededBy\s+Settlement\?[\s\S]{0,200}?onDelete:\s*SetNull/,
      'schema documents onDelete: SetNull on the supersededBy relation',
    );

    // …and the database enforces it: Postgres reports FK delete action 'n'
    // (SET NULL) for the Settlement → Settlement self-relation.
    const foreignKeys = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conrelid = '"Settlement"'::regclass
        AND confrelid = '"Settlement"'::regclass
        AND contype = 'f'
    `;
    t.deepEqual(
      foreignKeys.map((foreignKey) => foreignKey.confdeltype),
      ['n'],
      "database FK delete action is 'n' (ON DELETE SET NULL)",
    );

    // Deleting the replacement must not throw (Restrict/NoAction would) and
    // must not remove the retries (Cascade would).
    await prisma.settlement.delete({ where: { id: parent.id } });

    const remaining = await prisma.settlement.findMany({
      where: { id: { in: [CHILD_FIRST_ID, CHILD_SECOND_ID] } },
      select: { id: true, supersededById: true },
      orderBy: { id: 'asc' },
    });
    t.equal(remaining.length, 2, 'both retries survive the deletion of their replacement');
    t.ok(
      remaining.every((row) => row.supersededById === null),
      'retry links are cleared to NULL instead of dangling',
    );
    t.equal(
      await prisma.settlement.count({ where: { supersededById: parent.id } }),
      0,
      'no settlement is left referencing the deleted replacement',
    );
  } catch (error) {
    t.fail(`unexpected error: ${(error as Error).message}`);
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      // The pool teardown below always runs; nothing to recover here.
    }
    await pool.end();
    t.end();
  }
});
