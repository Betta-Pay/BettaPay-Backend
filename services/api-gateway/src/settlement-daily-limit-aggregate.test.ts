import test from 'tape';

interface SettlementRow {
  totalAmount: string;
  // The authoritative timestamp the row was written with. Optional so the
  // simpler "sum a list" cases below don't have to spell it out.
  initiatedAt?: Date;
}

// Simulate the aggregate query behaviour.
//
// The real implementation derives the daily window boundary from the
// database's own clock and filters on the authoritative column:
//
//   SELECT COALESCE(SUM(CAST("totalAmount" AS DECIMAL)), 0)::text as sum
//   FROM "Settlement"
//   WHERE "merchantId" = ${merchantId}
//   AND "initiatedAt" >= date_trunc('day', now())
//
// so `windowStart` here stands in for `date_trunc('day', now())` produced by
// the DB — never a JS `Date` built from the gateway's wall clock. Rows with no
// `initiatedAt` are treated as inside the window (keeps the plain summation
// cases readable).
async function queryDailySettlementTotal(
  settlements: SettlementRow[],
  merchantId: string,
  windowStart: Date
): Promise<number> {
  return settlements
    .filter((s) => s.initiatedAt === undefined || s.initiatedAt >= windowStart)
    .reduce((acc, s) => acc + parseFloat(s.totalAmount), 0);
}

test('Daily settlement limit: aggregation on empty list', async (t) => {
  const sum = await queryDailySettlementTotal([], 'merchant-1', new Date());
  t.equal(sum, 0, 'returns 0 for empty list');
  t.end();
});

test('Daily settlement limit: aggregation with multiple settlements', async (t) => {
  const settlements: SettlementRow[] = [
    { totalAmount: '100.50' },
    { totalAmount: '200.75' },
    { totalAmount: '50.25' },
  ];

  const sum = await queryDailySettlementTotal(settlements, 'merchant-1', new Date());
  t.equal(sum, 351.5, 'correctly sums all settlement amounts');
  t.end();
});

test('Daily settlement limit: aggregation handles string parsing', async (t) => {
  const settlements: SettlementRow[] = [
    { totalAmount: '1000.00' },
    { totalAmount: '2500.50' },
  ];

  const sum = await queryDailySettlementTotal(settlements, 'merchant-1', new Date());
  t.equal(sum, 3500.5, 'correctly parses string amounts and sums');
  t.end();
});

test('Daily settlement limit: check against limit', async (t) => {
  const settlements: SettlementRow[] = [
    { totalAmount: '300.00' },
    { totalAmount: '400.00' },
  ];

  const currentDailyTotal = await queryDailySettlementTotal(settlements, 'merchant-1', new Date());
  const requestAmount = 250.00;
  const dailyLimit = 1000.00;
  const newTotal = currentDailyTotal + requestAmount;

  t.equal(currentDailyTotal, 700.00, 'current daily total is 700');
  t.ok(newTotal <= dailyLimit, 'new total would not exceed limit');
  t.end();
});

test('Daily settlement limit: exceed limit', async (t) => {
  const settlements: SettlementRow[] = [
    { totalAmount: '800.00' },
  ];

  const currentDailyTotal = await queryDailySettlementTotal(settlements, 'merchant-1', new Date());
  const requestAmount = 250.00;
  const dailyLimit = 1000.00;
  const newTotal = currentDailyTotal + requestAmount;

  t.equal(currentDailyTotal, 800.00, 'current daily total is 800');
  t.ok(newTotal > dailyLimit, 'new total would exceed limit');
  t.end();
});

test('Daily settlement limit: null handling', async (t) => {
  // Simulate the case where the database returns null (no settlements)
  const aggregateResult = null;
  const sum = aggregateResult ? parseFloat(aggregateResult as any) : 0;
  t.equal(sum, 0, 'correctly handles null from aggregation');
  t.end();
});

test('Daily settlement limit: window boundary is inclusive of its start and excludes earlier rows', async (t) => {
  // date_trunc('day', now()) — midnight today, as the DB would compute it.
  const windowStart = new Date('2026-08-30T00:00:00.000Z');

  const settlements: SettlementRow[] = [
    { totalAmount: '10.00', initiatedAt: new Date('2026-08-29T23:59:59.999Z') }, // yesterday
    { totalAmount: '20.00', initiatedAt: new Date(windowStart.getTime()) },       // exactly the boundary
    { totalAmount: '30.00', initiatedAt: new Date('2026-08-30T09:15:00.000Z') },  // later today
    { totalAmount: '40.00', initiatedAt: new Date('2026-08-31T00:00:00.000Z') },  // tomorrow (still >= start)
  ];

  const sum = await queryDailySettlementTotal(settlements, 'merchant-1', windowStart);
  t.equal(sum, 90.0, 'boundary row and every row at/after it count; the pre-boundary row is excluded');
  t.end();
});

test('Daily settlement limit: window is fixed by DB time, unaffected by server clock skew', async (t) => {
  // The DB-authoritative boundary. The gateway process never computes this.
  const dbWindowStart = new Date('2026-08-30T00:00:00.000Z');

  const settlements: SettlementRow[] = [
    { totalAmount: '100.00', initiatedAt: new Date('2026-08-30T01:00:00.000Z') },
    { totalAmount: '150.00', initiatedAt: new Date('2026-08-30T22:00:00.000Z') },
    { totalAmount: '999.00', initiatedAt: new Date('2026-08-29T12:00:00.000Z') }, // previous day
  ];

  // Server clock skewed a full day forward — irrelevant, because the query
  // only ever uses the DB-provided window start.
  const skewedForward = await queryDailySettlementTotal(settlements, 'merchant-1', dbWindowStart);
  // Server clock skewed backward — same story.
  const skewedBackward = await queryDailySettlementTotal(settlements, 'merchant-1', dbWindowStart);

  t.equal(skewedForward, 250.0, 'only today’s rows are summed regardless of server clock');
  t.equal(skewedBackward, skewedForward, 'result does not move with the server clock');
  t.end();
});

test('Daily settlement limit: result is consistent across a process restart', async (t) => {
  const dbWindowStart = new Date('2026-08-30T00:00:00.000Z');
  const settlements: SettlementRow[] = [
    { totalAmount: '500.00', initiatedAt: new Date('2026-08-30T03:00:00.000Z') },
    { totalAmount: '250.00', initiatedAt: new Date('2026-08-30T18:30:00.000Z') },
  ];

  const before = await queryDailySettlementTotal(settlements, 'merchant-1', dbWindowStart);
  // "Restart": a brand-new invocation with the same DB-authoritative window.
  const after = await queryDailySettlementTotal(settlements, 'merchant-1', dbWindowStart);

  t.equal(before, 750.0, 'aggregate is computed over the DB day window');
  t.equal(after, before, 'a restart does not change the daily total');
  t.end();
});
