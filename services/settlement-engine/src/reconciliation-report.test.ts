/**
 * reconciliation-report.test.ts
 *
 * Tests for the reconciliation report endpoint (/api/settlements/reconcile/report).
 * Verifies that reconciliation results are properly summarized and queryable.
 */

import test from 'tape';

// Mock reconciliation report response structure
interface ReconciliationReport {
  timestamp: string;
  merchantId: string | null;
  period: {
    from: string | null;
    to: string | null;
  };
  status: 'clean' | 'discrepancies_found';
  summary: {
    totalLocal: number;
    totalGateway: number;
    matched: number;
    missing: number;
    extra: number;
    mismatched: number;
  };
  amounts: {
    local: {
      gross: string;
      fee: string;
      net: string;
    };
    gateway: {
      gross: string;
      fee: string;
      net: string;
    };
    differences: {
      gross: string;
      fee: string;
      net: string;
    };
  };
  alerts: string[];
}

// Helper to simulate report generation
function generateReconciliationReport(
  localRecords: any[],
  gatewayRecords: any[],
  merchantId?: string,
  from?: string,
  to?: string
): ReconciliationReport {
  const localIds = new Set(localRecords.map(r => r.id));
  const gatewayIds = new Set(gatewayRecords.map(r => r.id));

  const missing = gatewayRecords.filter(r => !localIds.has(r.id));
  const extra = localRecords.filter(r => !gatewayIds.has(r.id));

  const matchedIds = [...localIds].filter(id => gatewayIds.has(id));
  
  const localMap = new Map(localRecords.map(r => [r.id, r]));
  const gatewayMap = new Map(gatewayRecords.map(r => [r.id, r]));

  let mismatchedCount = 0;
  for (const id of matchedIds) {
    const localRec = localMap.get(id)!;
    const gatewayRec = gatewayMap.get(id);
    
    if (localRec.grossAmount !== gatewayRec.grossAmount || 
        localRec.feeAmount !== gatewayRec.feeAmount ||
        localRec.netAmount !== gatewayRec.netAmount) {
      mismatchedCount++;
    }
  }

  const matchedCount = matchedIds.length - mismatchedCount;

  // Calculate totals
  const localGross = localRecords.reduce((sum, r) => sum + parseFloat(r.grossAmount), 0);
  const localFee = localRecords.reduce((sum, r) => sum + parseFloat(r.feeAmount), 0);
  const localNet = localRecords.reduce((sum, r) => sum + parseFloat(r.netAmount), 0);

  const gatewayGross = gatewayRecords.reduce((sum, r) => sum + parseFloat(r.grossAmount), 0);
  const gatewayFee = gatewayRecords.reduce((sum, r) => sum + parseFloat(r.feeAmount), 0);
  const gatewayNet = gatewayRecords.reduce((sum, r) => sum + parseFloat(r.netAmount), 0);

  const grossDiff = (localGross - gatewayGross).toFixed(2);
  const feeDiff = (localFee - gatewayFee).toFixed(2);
  const netDiff = (localNet - gatewayNet).toFixed(2);

  const hasDiscrepancies = missing.length > 0 || extra.length > 0 || mismatchedCount > 0;
  const hasAmountDifferences = grossDiff !== '0.00' || feeDiff !== '0.00' || netDiff !== '0.00';

  const alerts: string[] = [];
  if (missing.length > 0) alerts.push(`${missing.length} settlement(s) in gateway but missing in local database`);
  if (extra.length > 0) alerts.push(`${extra.length} settlement(s) in local database but missing in gateway`);
  if (mismatchedCount > 0) alerts.push(`${mismatchedCount} settlement(s) with field mismatches`);
  if (grossDiff !== '0.00') alerts.push(`Gross amount difference: ${grossDiff}`);
  if (feeDiff !== '0.00') alerts.push(`Fee amount difference: ${feeDiff}`);
  if (netDiff !== '0.00') alerts.push(`Net amount difference: ${netDiff}`);

  return {
    timestamp: new Date().toISOString(),
    merchantId: merchantId || null,
    period: {
      from: from || null,
      to: to || null,
    },
    status: hasDiscrepancies ? 'discrepancies_found' : 'clean',
    summary: {
      totalLocal: localRecords.length,
      totalGateway: gatewayRecords.length,
      matched: matchedCount,
      missing: missing.length,
      extra: extra.length,
      mismatched: mismatchedCount,
    },
    amounts: {
      local: {
        gross: localGross.toFixed(2),
        fee: localFee.toFixed(2),
        net: localNet.toFixed(2),
      },
      gateway: {
        gross: gatewayGross.toFixed(2),
        fee: gatewayFee.toFixed(2),
        net: gatewayNet.toFixed(2),
      },
      differences: {
        gross: grossDiff,
        fee: feeDiff,
        net: netDiff,
      },
    },
    alerts,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reconciliation Report Tests
// ═══════════════════════════════════════════════════════════════════════════════

test('reconciliation report: clean reconciliation with no discrepancies', (t) => {
  const settlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(settlements, settlements);

  t.equal(report.status, 'clean', 'status should be clean');
  t.equal(report.summary.totalLocal, 2, 'should have 2 local records');
  t.equal(report.summary.totalGateway, 2, 'should have 2 gateway records');
  t.equal(report.summary.matched, 2, 'should have 2 matched records');
  t.equal(report.summary.missing, 0, 'should have 0 missing records');
  t.equal(report.summary.extra, 0, 'should have 0 extra records');
  t.equal(report.summary.mismatched, 0, 'should have 0 mismatched records');
  t.equal(report.alerts.length, 0, 'should have no alerts');
  t.equal(report.amounts.differences.gross, '0.00', 'gross difference should be 0');
  t.equal(report.amounts.differences.fee, '0.00', 'fee difference should be 0');
  t.equal(report.amounts.differences.net, '0.00', 'net difference should be 0');

  t.end();
});

test('reconciliation report: detects missing settlements in local database', (t) => {
  const localSettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const gatewaySettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(localSettlements, gatewaySettlements);

  t.equal(report.status, 'discrepancies_found', 'status should indicate discrepancies');
  t.equal(report.summary.missing, 1, 'should have 1 missing record');
  t.equal(report.summary.extra, 0, 'should have 0 extra records');
  t.ok(report.alerts.some(a => a.includes('1 settlement(s) in gateway but missing in local')), 'should alert about missing settlement');

  t.end();
});

test('reconciliation report: detects extra settlements in local database', (t) => {
  const localSettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00', asset: 'USDC', status: 'completed' },
  ];

  const gatewaySettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(localSettlements, gatewaySettlements);

  t.equal(report.status, 'discrepancies_found', 'status should indicate discrepancies');
  t.equal(report.summary.missing, 0, 'should have 0 missing records');
  t.equal(report.summary.extra, 1, 'should have 1 extra record');
  t.ok(report.alerts.some(a => a.includes('1 settlement(s) in local database but missing in gateway')), 'should alert about extra settlement');

  t.end();
});

test('reconciliation report: detects mismatched settlement amounts', (t) => {
  const localSettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const gatewaySettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.50', netAmount: '98.50', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(localSettlements, gatewaySettlements);

  t.equal(report.status, 'discrepancies_found', 'status should indicate discrepancies');
  t.equal(report.summary.mismatched, 1, 'should have 1 mismatched record');
  t.equal(report.summary.matched, 0, 'should have 0 perfectly matched records');
  t.ok(report.alerts.some(a => a.includes('1 settlement(s) with field mismatches')), 'should alert about mismatch');

  t.end();
});

test('reconciliation report: calculates amount differences correctly', (t) => {
  const localSettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00', asset: 'USDC', status: 'completed' },
  ];

  const gatewaySettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(localSettlements, gatewaySettlements);

  t.equal(report.amounts.local.gross, '300.00', 'local gross total should be 300');
  t.equal(report.amounts.gateway.gross, '100.00', 'gateway gross total should be 100');
  t.equal(report.amounts.differences.gross, '200.00', 'gross difference should be 200');
  t.ok(report.alerts.some(a => a.includes('Gross amount difference: 200.00')), 'should alert about gross difference');

  t.end();
});

test('reconciliation report: includes merchant filter in response', (t) => {
  const settlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(settlements, settlements, 'M1');

  t.equal(report.merchantId, 'M1', 'merchant ID should be included');
  t.equal(report.summary.totalLocal, 1, 'should have 1 record');

  t.end();
});

test('reconciliation report: includes date range filter in response', (t) => {
  const settlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(settlements, settlements, undefined, '2024-01-01', '2024-01-31');

  t.equal(report.period.from, '2024-01-01', 'from date should be included');
  t.equal(report.period.to, '2024-01-31', 'to date should be included');

  t.end();
});

test('reconciliation report: handles empty result sets', (t) => {
  const report = generateReconciliationReport([], []);

  t.equal(report.status, 'clean', 'empty sets should be clean');
  t.equal(report.summary.totalLocal, 0, 'should have 0 local records');
  t.equal(report.summary.totalGateway, 0, 'should have 0 gateway records');
  t.equal(report.alerts.length, 0, 'should have no alerts');

  t.end();
});

test('reconciliation report: combines multiple discrepancy types', (t) => {
  const localSettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
    { id: '3', merchantId: 'M1', grossAmount: '300.00', feeAmount: '3.00', netAmount: '297.00', asset: 'USDC', status: 'completed' },
  ];

  const gatewaySettlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.50', netAmount: '98.50', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(localSettlements, gatewaySettlements);

  t.equal(report.status, 'discrepancies_found', 'status should indicate discrepancies');
  t.equal(report.summary.missing, 1, 'should have 1 missing (id=2)');
  t.equal(report.summary.extra, 1, 'should have 1 extra (id=3)');
  t.equal(report.summary.mismatched, 1, 'should have 1 mismatched (id=1)');
  t.equal(report.alerts.length, 5, 'should have 5 alerts (missing, extra, mismatch, fee diff, net diff)');

  t.end();
});

test('reconciliation report: timestamp is ISO format', (t) => {
  const settlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(settlements, settlements);

  t.ok(report.timestamp, 'timestamp should be present');
  t.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(report.timestamp), 'timestamp should be ISO 8601 format');

  t.end();
});

test('reconciliation report: totals match individual record sums', (t) => {
  const settlements = [
    { id: '1', merchantId: 'M1', grossAmount: '100.50', feeAmount: '1.25', netAmount: '99.25', asset: 'USDC', status: 'completed' },
    { id: '2', merchantId: 'M1', grossAmount: '250.75', feeAmount: '2.50', netAmount: '248.25', asset: 'USDC', status: 'completed' },
    { id: '3', merchantId: 'M1', grossAmount: '75.00', feeAmount: '0.75', netAmount: '74.25', asset: 'USDC', status: 'completed' },
  ];

  const report = generateReconciliationReport(settlements, settlements);

  t.equal(report.amounts.local.gross, '426.25', 'local gross should be 426.25');
  t.equal(report.amounts.local.fee, '4.50', 'local fee should be 4.50');
  t.equal(report.amounts.local.net, '421.75', 'local net should be 421.75');

  t.end();
});
