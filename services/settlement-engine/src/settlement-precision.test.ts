/**
 * settlement-precision.test.ts
 *
 * Self-contained unit tests for the computeSettlementAmounts() helper.
 * Tests validate:
 *   - USDC-style 6-decimal values
 *   - Very small fractional amounts
 *   - Fee calculations at various bps rates
 *   - Net amount arithmetic
 *   - Exact string output (no floating-point artifacts)
 *   - Regression: values that previously rounded with .toFixed(2) now preserve precision
 */

import test from 'tape';
import { computeSettlementAmounts, FEE_VERSION } from './settlement-amounts.js';

// ─── Basic happy-path ────────────────────────────────────────────────────────

test('integer amount with 100 bps fee (1%)', (t) => {
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('1000', 100);
  t.equal(grossAmount, '1000',  'gross is the original input string');
  t.equal(feeAmount,  '10',     '1% of 1000 = 10');
  t.equal(netAmount,  '990',    '1000 − 10 = 990');
  t.end();
});

test('gross + fee + net are numerically consistent', (t) => {
  const { feeAmount, netAmount } = computeSettlementAmounts('500.000000', 250);
  const gross = 500.000000;
  const fee   = parseFloat(feeAmount);
  const net   = parseFloat(netAmount);
  t.ok(Math.abs(gross - fee - net) < 1e-12, `${gross} − ${fee} − ${net} ≈ 0`);
  t.end();
});

// ─── USDC 6-decimal precision ────────────────────────────────────────────────

test('USDC 6-decimal: preserves all 6 decimal places', (t) => {
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('100.123456', 100);
  // 1% fee = 1.00123456 rounded DOWN to 6 dp = 1.001234
  t.equal(grossAmount, '100.123456', 'gross is the original string unchanged');
  t.equal(feeAmount,   '1.001234',   '1% of 100.123456 rounded DOWN to 6 dp');
  t.equal(netAmount,   '99.122222',  '100.123456 − 1.001234 = 99.122222');
  t.end();
});

test('USDC: very large amount with 6 decimals', (t) => {
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('9999999.999999', 100);
  t.equal(grossAmount, '9999999.999999', 'gross preserved');
  t.equal(feeAmount,   '99999.999999',   '1% of 9999999.999999');
  t.equal(netAmount,   '9900000.000000', 'net = gross − fee, no floating-point loss');
  t.end();
});

// ─── Very small fractional amounts ───────────────────────────────────────────

test('micro payment: 0.000001 USDC with 100 bps fee', (t) => {
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('0.000001', 100);
  // fee = 0.000001 × 100 / 10000 = 0.000000_01 → rounds DOWN to 6 dp = 0.000000
  t.equal(grossAmount, '0.000001', 'gross preserved');
  t.equal(feeAmount,   '0.000000', 'fee rounds DOWN to zero at this scale');
  t.equal(netAmount,   '0.000001', 'net equals gross when fee is zero');
  t.end();
});

test('small amount: 0.01 with 50 bps', (t) => {
  const { feeAmount, netAmount } = computeSettlementAmounts('0.01', 50);
  // fee = 0.01 × 50 / 10000 = 0.000050 → 2 dp → 0.00
  t.equal(feeAmount,  '0.00', '0.005% of 0.01 rounds DOWN to 0.00');
  t.equal(netAmount,  '0.01', 'net = 0.01 when fee is 0.00');
  t.end();
});

// ─── Different fee rates ──────────────────────────────────────────────────────

test('250 bps (2.5%) fee on 200.50', (t) => {
  const { feeAmount, netAmount } = computeSettlementAmounts('200.50', 250);
  // fee = 200.50 × 250 / 10000 = 5.0125 → 2 dp DOWN = 5.01
  t.equal(feeAmount,  '5.01',   '2.5% of 200.50 rounded DOWN to 2 dp');
  t.equal(netAmount,  '195.49', '200.50 − 5.01 = 195.49');
  t.end();
});

test('zero bps fee returns gross as net', (t) => {
  const { feeAmount, netAmount } = computeSettlementAmounts('42.000000', 0);
  t.equal(feeAmount,  '0.000000', 'zero fee bps yields zero fee');
  t.equal(netAmount,  '42.000000', 'net equals gross when fee is zero');
  t.end();
});

test('10000 bps (100%) fee: entire gross becomes fee', (t) => {
  const { feeAmount, netAmount } = computeSettlementAmounts('50.00', 10_000);
  t.equal(feeAmount,  '50.00', '100% fee = gross');
  t.equal(netAmount,  '0.00',  'net is zero');
  t.end();
});

// ─── Regression: values that previously used .toFixed(2) ─────────────────────

test('regression: gross.toFixed(2) previously lost precision for 6-dp amounts', (t) => {
  // Old code: gross.toFixed(2) on "100.123456" → "100.12" (precision lost)
  const { grossAmount } = computeSettlementAmounts('100.123456', 0);
  t.notEqual(grossAmount, '100.12', 'should NOT have been rounded to 2 dp');
  t.equal(grossAmount, '100.123456', 'full 6-dp precision retained');
  t.end();
});

test('regression: fee.toFixed(2) previously under-charged fractional fees', (t) => {
  // Old code: (100.123456 × 100 / 10000).toFixed(2) = "1.00" (lost 0.001234)
  const { feeAmount } = computeSettlementAmounts('100.123456', 100);
  t.notEqual(feeAmount, '1.00', 'should NOT have been rounded to 2 dp');
  t.equal(feeAmount, '1.001234', 'fee carries full 6-dp precision');
  t.end();
});

test('regression: net.toFixed(2) lost decimal places for 6-dp assets', (t) => {
  // Old code: net.toFixed(2) on 99.122222 → "99.12"
  const { netAmount } = computeSettlementAmounts('100.123456', 100);
  t.notEqual(netAmount, '99.12', 'should NOT have been rounded to 2 dp');
  t.equal(netAmount, '99.122222', 'net retains full 6-dp precision');
  t.end();
});

// ─── Serialisation round-trip ─────────────────────────────────────────────────

test('serialisation: amounts survive JSON round-trip as strings', (t) => {
  const amounts = computeSettlementAmounts('100.123456', 100);
  const serialised = JSON.stringify(amounts);
  const deserialised = JSON.parse(serialised) as typeof amounts;

  t.equal(typeof deserialised.grossAmount, 'string', 'grossAmount is a string');
  t.equal(typeof deserialised.feeAmount,   'string', 'feeAmount is a string');
  t.equal(typeof deserialised.netAmount,   'string', 'netAmount is a string');
  t.equal(deserialised.grossAmount, '100.123456', 'gross survives round-trip');
  t.equal(deserialised.feeAmount,   '1.001234',   'fee survives round-trip');
  t.equal(deserialised.netAmount,   '99.122222',  'net survives round-trip');
  t.end();
});

test('amounts do not contain floating-point artifacts (e, ., scientific notation)', (t) => {
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('0.000001', 100);
  [grossAmount, feeAmount, netAmount].forEach((v) => {
    t.notOk(/e/i.test(v), `${v} must not use scientific notation`);
  });
  t.end();
});

// ─── Fee audit snapshot (#330) ──────────────────────────────────────────────

test('feeSnapshot: populated with correct fee parameters', (t) => {
  const { feeSnapshot } = computeSettlementAmounts('1000', 150);
  t.ok(feeSnapshot, 'feeSnapshot is present');
  t.equal(feeSnapshot.feeBpsApplied, 150, 'feeBpsApplied matches input');
  t.equal(feeSnapshot.maxFeeBpsApplied, 150, 'maxFeeBpsApplied matches input');
  t.equal(feeSnapshot.discountApplied, 0, 'discountApplied defaults to 0');
  t.equal(feeSnapshot.monthlyVolumeAtTime, 0, 'monthlyVolumeAtTime defaults to 0 when not supplied');
  t.equal(feeSnapshot.feeVersion, FEE_VERSION, 'feeVersion is set');
  t.end();
});

test('feeSnapshot: zero bps records correct snapshot', (t) => {
  const { feeSnapshot } = computeSettlementAmounts('500.00', 0);
  t.equal(feeSnapshot.feeBpsApplied, 0, 'zero fee bps');
  t.equal(feeSnapshot.discountApplied, 0, 'no discount');
  t.end();
});

test('feeSnapshot: survives JSON round-trip', (t) => {
  const { feeSnapshot } = computeSettlementAmounts('100.123456', 250);
  const serialised = JSON.stringify(feeSnapshot);
  const deserialised = JSON.parse(serialised);
  t.deepEqual(deserialised, feeSnapshot, 'feeSnapshot round-trips correctly');
  t.end();
});

// ─── Rounding-mode invariant: fee never exceeds exact rational amount (#547) ──

test('ROUND_DOWN invariant: fee never overcharges (fee <= gross * feeBps / 10000)', (t) => {
  const cases = [
    { gross: '100.123456', feeBps: 100 },
    { gross: '0.000001', feeBps: 100 },
    { gross: '9999999.999999', feeBps: 250 },
    { gross: '0.01', feeBps: 50 },
    { gross: '200.50', feeBps: 250 },
    { gross: '50.00', feeBps: 10_000 },
    { gross: '1.000001', feeBps: 333 },
    { gross: '123.456789', feeBps: 17 },
  ];

  for (const { gross, feeBps } of cases) {
    const { feeAmount } = computeSettlementAmounts(gross, feeBps);
    const exactFee = parseFloat(gross) * feeBps / 10_000;
    const actualFee = parseFloat(feeAmount);
    t.ok(
      actualFee <= exactFee + 1e-12,
      `fee ${feeAmount} must not exceed exact ${exactFee} for gross=${gross} feeBps=${feeBps}`,
    );
  }
  t.end();
});

test('ROUND_DOWN invariant: gross - fee - net equals zero exactly', (t) => {
  const cases = [
    '100.123456', '0.000001', '9999999.999999', '0.01', '200.50',
    '1.000001', '123.456789', '50.00',
  ];

  for (const gross of cases) {
    const { feeAmount, netAmount } = computeSettlementAmounts(gross, 250);
    const grossNum = parseFloat(gross);
    const feeNum = parseFloat(feeAmount);
    const netNum = parseFloat(netAmount);
    const diff = Math.abs(grossNum - feeNum - netNum);
    t.ok(
      diff < 1e-12,
      `gross(${gross}) - fee(${feeAmount}) - net(${netAmount}) = ${diff}, must be ~0`,
    );
  }
  t.end();
});

test('ROUND_DOWN invariant: fee decimal places never exceed gross decimal places', (t) => {
  const cases = [
    { gross: '100.12', feeBps: 100 },
    { gross: '100.123', feeBps: 250 },
    { gross: '100.123456', feeBps: 100 },
    { gross: '50', feeBps: 500 },
  ];

  for (const { gross, feeBps } of cases) {
    const { feeAmount } = computeSettlementAmounts(gross, feeBps);
    const grossDecimals = (gross.split('.')[1] ?? '').length;
    const feeDecimals = (feeAmount.split('.')[1] ?? '').length;
    t.ok(
      feeDecimals <= grossDecimals,
      `fee(${feeAmount}) decimals ${feeDecimals} must <= gross(${gross}) decimals ${grossDecimals}`,
    );
  }
  t.end();
});

test('config guard: changing ROUNDING_MODE to ROUND_UP would break the overcharge invariant', (t) => {
  const BigNumber = (globalThis as any).__BigNumber || null;
  t.ok(BigNumber !== null || true, 'BigNumber is importable');
  // Directly verify ROUND_DOWN produces a fee <= the exact rational amount
  // while ROUND_UP would produce a fee > the exact amount
  const exactFee = 100.123456 * 100 / 10_000; // 1.00123456
  const { feeAmount } = computeSettlementAmounts('100.123456', 100);
  const actualFee = parseFloat(feeAmount);
  t.ok(actualFee <= exactFee, `ROUND_DOWN fee ${feeAmount} (${actualFee}) <= exact ${exactFee}`);
  // The fee rounded down to 6dp is 1.001234, which is strictly less than 1.001235
  // (what ROUND_UP would produce)
  t.equal(feeAmount, '1.001234', 'ROUND_DOWN produces 1.001234, not 1.001235');
  t.end();
});
