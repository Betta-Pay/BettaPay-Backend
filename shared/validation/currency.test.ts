import test from 'node:test';
import assert from 'node:assert';
import { CurrencyCode, ASSET_DECIMALS, validateAmountPrecision } from './currency.js';
import {
  CurrencyCode as ExportedCurrencyCode,
  ASSET_DECIMALS as EXPORTED_ASSET_DECIMALS,
  validateAmountPrecision as exportedValidateAmountPrecision,
} from './index.js';

test('shared/validation/currency exports are re-exported by package index', () => {
  assert.strictEqual(ExportedCurrencyCode, CurrencyCode);
  assert.strictEqual(EXPORTED_ASSET_DECIMALS, ASSET_DECIMALS);
  assert.strictEqual(exportedValidateAmountPrecision, validateAmountPrecision);
});

test('ASSET_DECIMALS: defines correct maximum decimal places for all supported assets', () => {
  // Pin decimals for each supported asset
  assert.strictEqual(ASSET_DECIMALS.USDC, 7, 'USDC should have 7 decimals');
  assert.strictEqual(ASSET_DECIMALS.EURT, 7, 'EURT should have 7 decimals');
  assert.strictEqual(ASSET_DECIMALS.NGN, 2, 'NGN should have 2 decimals');

  // Verify all CurrencyCode enum values have a defined decimal precision
  for (const asset of CurrencyCode.options) {
    assert.strictEqual(
      typeof ASSET_DECIMALS[asset],
      'number',
      `Asset ${asset} must have an entry in ASSET_DECIMALS`,
    );
    assert.ok(
      ASSET_DECIMALS[asset] >= 0,
      `Asset ${asset} decimals must be non-negative`,
    );
  }
});

test('CurrencyCode: accepts supported assets and rejects unknown currencies', () => {
  assert.strictEqual(CurrencyCode.safeParse('USDC').success, true);
  assert.strictEqual(CurrencyCode.safeParse('EURT').success, true);
  assert.strictEqual(CurrencyCode.safeParse('NGN').success, true);

  // Unknown currencies rejected
  assert.strictEqual(CurrencyCode.safeParse('BTC').success, false);
  assert.strictEqual(CurrencyCode.safeParse('ETH').success, false);
  assert.strictEqual(CurrencyCode.safeParse('USD').success, false);
  assert.strictEqual(CurrencyCode.safeParse('').success, false);
  assert.strictEqual(CurrencyCode.safeParse('usdc').success, false);
});

test('validateAmountPrecision: accepts boundary values at exact precision', () => {
  // Integer amounts (no decimal point)
  assert.strictEqual(validateAmountPrecision('0', 'USDC'), true);
  assert.strictEqual(validateAmountPrecision('100', 'USDC'), true);
  assert.strictEqual(validateAmountPrecision('1000000', 'NGN'), true);

  // Partial precision under maximum decimals
  assert.strictEqual(validateAmountPrecision('1.5', 'USDC'), true);
  assert.strictEqual(validateAmountPrecision('10.12', 'USDC'), true);
  assert.strictEqual(validateAmountPrecision('10.5', 'NGN'), true);

  // Exact maximum decimal places
  assert.strictEqual(
    validateAmountPrecision('100.1234567', 'USDC'),
    true,
    'USDC with exactly 7 decimal places must be accepted',
  );
  assert.strictEqual(
    validateAmountPrecision('0.0000001', 'EURT'),
    true,
    'EURT with exactly 7 decimal places must be accepted',
  );
  assert.strictEqual(
    validateAmountPrecision('9999.99', 'NGN'),
    true,
    'NGN with exactly 2 decimal places must be accepted',
  );
  assert.strictEqual(
    validateAmountPrecision('0.01', 'NGN'),
    true,
    'NGN with exactly 2 decimal places must be accepted',
  );
});

test('validateAmountPrecision: rejects amounts exceeding asset decimal precision', () => {
  // USDC: 7 decimals max, 8 decimals must be rejected
  assert.strictEqual(
    validateAmountPrecision('100.12345678', 'USDC'),
    false,
    'USDC with 8 decimals must be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('0.00000001', 'USDC'),
    false,
    'USDC with 8 decimals must be rejected',
  );

  // EURT: 7 decimals max, 8 decimals must be rejected
  assert.strictEqual(
    validateAmountPrecision('50.12345678', 'EURT'),
    false,
    'EURT with 8 decimals must be rejected',
  );

  // NGN: 2 decimals max, 3 or more decimals must be rejected
  assert.strictEqual(
    validateAmountPrecision('100.123', 'NGN'),
    false,
    'NGN with 3 decimals must be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('10.001', 'NGN'),
    false,
    'NGN with 3 decimals must be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('0.0001', 'NGN'),
    false,
    'NGN with 4 decimals must be rejected',
  );
});

test('validateAmountPrecision: rejects unknown currencies', () => {
  assert.strictEqual(
    validateAmountPrecision('100', 'BTC'),
    false,
    'Unknown asset BTC should be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('100.50', 'ETH'),
    false,
    'Unknown asset ETH should be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('100.50', 'USD'),
    false,
    'Unknown asset USD should be rejected',
  );
  assert.strictEqual(
    validateAmountPrecision('100', ''),
    false,
    'Empty asset should be rejected',
  );
});
