/**
 * Pins the database-level guards added for #1096:
 *
 *   - Settlement.batchId is a real FK to SettlementBatch (ON DELETE SET NULL),
 *     so a settlement can no longer reference a batch that does not exist.
 *   - Monetary String columns on Settlement and SettlementBatch carry CHECK
 *     constraints that only accept non-negative decimal strings.
 *
 * Prisma does not model CHECK constraints and the CI test database is built
 * with `prisma db push`, so this test runs the CHECK statements from the
 * migration itself (they are idempotent) inside a transaction that is always
 * rolled back — it exercises the shipped SQL and leaves the database as found.
 *
 * Runs against DATABASE_URL; skipped locally when no database is reachable.
 */
import test from 'tape';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATION = new URL(
  '../prisma/migrations/20261119000000_settlement_batch_fk_amount_checks/migration.sql',
  import.meta.url,
);
const MERCHANT_ID = 'fk-1096-merchant';
const BATCH_ID = 'batch_fk1096';

/** The DROP/ADD CONSTRAINT ... CHECK statements from the migration. */
function checkStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /_numeric_check"/.test(statement));
}

function settlementRow(overrides: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    id: 'fk-1096-settlement',
    merchantId: MERCHANT_ID,
    totalAmount: '100.25',
    grossAmount: '100.25',
    feeAmount: '1.0025',
    netAmount: '99.2475',
    feeBps: 100,
    asset: 'USDC',
    batchId: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    text: `INSERT INTO "Settlement" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values: Object.values(row),
  };
}

test('Settlement.batchId FK and amount CHECK constraints (#1096)', async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    const message = `PostgreSQL unreachable at ${process.env.DATABASE_URL ?? '<unset DATABASE_URL>'}: ${(error as Error).message}`;
    if (process.env.CI) t.fail(message);
    else console.warn(`[settlement-fk-1096] skipping: ${message}`);
    await pool.end();
    t.end();
    return;
  }

  /** Runs `query` in a savepoint and returns the Postgres error code it raised, if any. */
  async function errorCode(query: { text: string; values?: unknown[] } | string): Promise<string | undefined> {
    await client.query('SAVEPOINT probe');
    try {
      await client.query(query);
      await client.query('RELEASE SAVEPOINT probe');
      return undefined;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT probe');
      return (error as { code?: string }).code;
    }
  }

  try {
    await client.query('BEGIN');

    const statements = checkStatements();
    t.equal(statements.length, 14, 'migration drops and re-adds 7 CHECK constraints');
    for (const statement of statements) await client.query(statement);
    // Applying them twice must also succeed: the CI rollback job leaves CHECKs
    // in place (Prisma cannot diff them) before re-applying the migration.
    for (const statement of statements) await client.query(statement);

    const fk = await client.query<{ confdeltype: string }>(`
      SELECT confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conrelid = '"Settlement"'::regclass
        AND confrelid = '"SettlementBatch"'::regclass
        AND contype = 'f'
    `);
    t.deepEqual(fk.rows.map((r) => r.confdeltype), ['n'], 'Settlement → SettlementBatch FK exists with ON DELETE SET NULL');

    await client.query(
      `INSERT INTO "Merchant" ("id", "name", "ownerId") VALUES ($1, 'FK test merchant', 'owner-1096')`,
      [MERCHANT_ID],
    );

    t.equal(await errorCode(settlementRow()), undefined, 'valid decimal amounts are accepted');
    t.equal(
      await errorCode(settlementRow({ id: 'fk-1096-orphan', batchId: 'batch_does_not_exist' })),
      '23503',
      'a batchId with no SettlementBatch row is rejected (foreign_key_violation)',
    );

    for (const column of ['totalAmount', 'grossAmount', 'feeAmount', 'netAmount']) {
      for (const bad of ['abc', '', '-1', '1e5', '1.', '.5', '1,000', ' 1', 'NaN']) {
        t.equal(
          await errorCode(settlementRow({ id: `fk-1096-bad`, [column]: bad })),
          '23514',
          `Settlement.${column} rejects ${JSON.stringify(bad)} (check_violation)`,
        );
      }
    }

    t.equal(
      await errorCode(
        `INSERT INTO "SettlementBatch" ("id", "asset", "totalCount", "totalGross", "totalFees", "totalNet")
         VALUES ('batch_bad1096', 'USDC', 1, 'ten', '0', '10')`,
      ),
      '23514',
      'SettlementBatch amount columns reject non-numeric strings',
    );

    await client.query(
      `INSERT INTO "SettlementBatch" ("id", "asset", "totalCount", "totalGross", "totalFees", "totalNet")
       VALUES ($1, 'USDC', 1, '100.25', '1.0025', '99.2475')`,
      [BATCH_ID],
    );
    await client.query(`UPDATE "Settlement" SET "batchId" = $1 WHERE "id" = 'fk-1096-settlement'`, [BATCH_ID]);
    await client.query(`DELETE FROM "SettlementBatch" WHERE "id" = $1`, [BATCH_ID]);
    const after = await client.query<{ batchId: string | null }>(
      `SELECT "batchId" FROM "Settlement" WHERE "id" = 'fk-1096-settlement'`,
    );
    t.deepEqual(after.rows, [{ batchId: null }], 'deleting a batch unlinks its settlements instead of deleting them');
  } catch (error) {
    t.fail(`unexpected error: ${(error as Error).message}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
    t.end();
  }
});
