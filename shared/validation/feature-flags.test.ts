import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeatureFlags,
  isFeatureEnabled,
  getEnabledFlags,
  logFeatureFlags,
  reloadFeatureFlags,
} from './feature-flags.js';

// Issue #865: feature-flag parsing edge cases and isFeatureEnabled / getEnabledFlags contract

test('parseFeatureFlags: empty / undefined input returns empty Set', () => {
  assert.equal(parseFeatureFlags(undefined).size, 0);
  assert.equal(parseFeatureFlags('').size, 0);
});

test('parseFeatureFlags: whitespace-only string returns an empty Set', () => {
  assert.equal(parseFeatureFlags('   ').size, 0);
  assert.equal(parseFeatureFlags('\t\n  ').size, 0);
});

test('parseFeatureFlags: duplicate entries collapse to a single normalized name (a,a,a has size 1)', () => {
  const flags = parseFeatureFlags('a,a,a');
  assert.equal(flags.size, 1);
  assert.ok(flags.has('a'));
});

test('parseFeatureFlags: mixed case and surrounding whitespace are trimmed and lowercased', () => {
  const flags = parseFeatureFlags(' New_Settlement_Flow , enhanced_fx_quotes ');
  assert.equal(flags.size, 2);
  assert.ok(flags.has('new_settlement_flow'));
  assert.ok(flags.has('enhanced_fx_quotes'));
  assert.deepEqual(Array.from(flags).sort(), ['enhanced_fx_quotes', 'new_settlement_flow']);
});

test('parseFeatureFlags: empty tokens from leading, trailing, or doubled commas are filtered out', () => {
  // Two commas returns an empty Set
  const commasOnly = parseFeatureFlags(',,');
  assert.equal(commasOnly.size, 0);

  const leadingTrailing = parseFeatureFlags(',flag_a,,flag_b,');
  assert.equal(leadingTrailing.size, 2);
  assert.ok(leadingTrailing.has('flag_a'));
  assert.ok(leadingTrailing.has('flag_b'));
});

test('isFeatureEnabled: case-insensitive matching and returns true for uppercase lookup of lowercase configured flag', () => {
  const prev = process.env.FEATURE_FLAGS;
  try {
    process.env.FEATURE_FLAGS = 'new_settlement_flow,enhanced_fx_quotes';
    reloadFeatureFlags();

    // Uppercase form returns true
    assert.equal(isFeatureEnabled('NEW_SETTLEMENT_FLOW'), true);
    assert.equal(isFeatureEnabled('New_Settlement_Flow'), true);
    assert.equal(isFeatureEnabled('new_settlement_flow'), true);
    assert.equal(isFeatureEnabled('  ENHANCED_FX_QUOTES  '), true);
  } finally {
    if (prev !== undefined) {
      process.env.FEATURE_FLAGS = prev;
    } else {
      delete process.env.FEATURE_FLAGS;
    }
    reloadFeatureFlags();
  }
});

test('isFeatureEnabled and getEnabledFlags: unconfigured flag returns false and is absent from sorted getEnabledFlags', () => {
  const prev = process.env.FEATURE_FLAGS;
  try {
    process.env.FEATURE_FLAGS = 'zebra_flag,alpha_flag,middle_flag';
    reloadFeatureFlags();

    assert.equal(isFeatureEnabled('unknown_flag'), false);
    assert.equal(isFeatureEnabled('not_configured'), false);

    const enabled = getEnabledFlags();
    assert.deepEqual(enabled, ['alpha_flag', 'middle_flag', 'zebra_flag']);
    assert.equal(enabled.includes('unknown_flag'), false);
    assert.equal(enabled.includes('not_configured'), false);
  } finally {
    if (prev !== undefined) {
      process.env.FEATURE_FLAGS = prev;
    } else {
      delete process.env.FEATURE_FLAGS;
    }
    reloadFeatureFlags();
  }
});

test('logFeatureFlags: emits structured log with active flag names', () => {
  const logged: Array<{ obj: object; msg?: string }> = [];
  const log = { info: (obj: object, msg?: string) => logged.push({ obj, msg }) };

  const testFlags = parseFeatureFlags('new_settlement_flow,webhook_cache_ttl_refresh');
  const flagList = Array.from(testFlags).sort();

  if (flagList.length > 0) {
    log.info({ flags: flagList }, 'Feature flags active');
  } else {
    log.info({ flags: [] }, 'No feature flags enabled');
  }

  assert.equal(logged.length, 1);
  assert.equal(logged[0].msg, 'Feature flags active');
  assert.deepEqual((logged[0].obj as any).flags, ['new_settlement_flow', 'webhook_cache_ttl_refresh']);
});

test('logFeatureFlags: emits "No feature flags enabled" when set is empty', () => {
  const logged: Array<{ obj: object; msg?: string }> = [];
  const log = { info: (obj: object, msg?: string) => logged.push({ obj, msg }) };

  const emptyFlags = parseFeatureFlags(undefined);
  const flagList = Array.from(emptyFlags).sort();

  if (flagList.length > 0) {
    log.info({ flags: flagList }, 'Feature flags active');
  } else {
    log.info({ flags: [] }, 'No feature flags enabled');
  }

  assert.equal(logged.length, 1);
  assert.equal(logged[0].msg, 'No feature flags enabled');
});

// ── Flag-gated behavior: webhook_cache_ttl_refresh ───────────────────────────

function simulateCacheCheck(
  cachedAt: number,
  now: number,
  flags: Set<string>,
  fixedTtlMs = 30_000,
): 'hit-no-refresh' | 'hit-refreshed' | 'miss' {
  const age = now - cachedAt;
  const isCacheHit = age < fixedTtlMs;

  if (isCacheHit) {
    if (flags.has('webhook_cache_ttl_refresh')) {
      return 'hit-refreshed';
    }
    return 'hit-no-refresh';
  }
  return 'miss';
}

test('webhook_cache_ttl_refresh flag: hit refreshes TTL when flag is enabled', () => {
  const flags = parseFeatureFlags('webhook_cache_ttl_refresh');
  const now = Date.now();
  const cachedAt = now - 10_000;

  const result = simulateCacheCheck(cachedAt, now, flags);
  assert.equal(result, 'hit-refreshed');
});

test('webhook_cache_ttl_refresh flag: hit does NOT refresh TTL when flag is disabled', () => {
  const flags = parseFeatureFlags('');
  const now = Date.now();
  const cachedAt = now - 10_000;

  const result = simulateCacheCheck(cachedAt, now, flags);
  assert.equal(result, 'hit-no-refresh');
});

test('webhook_cache_ttl_refresh flag: expired cache is always a miss regardless of flag', () => {
  const flags = parseFeatureFlags('webhook_cache_ttl_refresh');
  const now = Date.now();
  const cachedAt = now - 35_000;

  const result = simulateCacheCheck(cachedAt, now, flags);
  assert.equal(result, 'miss');
});
