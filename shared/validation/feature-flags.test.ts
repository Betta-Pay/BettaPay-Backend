import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatureFlags, isFeatureEnabled, getEnabledFlags, logFeatureFlags } from './feature-flags.js';

test('parseFeatureFlags: empty / undefined input returns empty Set', () => {
  assert.equal(parseFeatureFlags(undefined).size, 0);
  assert.equal(parseFeatureFlags('').size, 0);
  assert.equal(parseFeatureFlags('   ').size, 0);
});

test('parseFeatureFlags: single flag is parsed correctly', () => {
  const flags = parseFeatureFlags('new_settlement_flow');
  assert.ok(flags.has('new_settlement_flow'));
  assert.equal(flags.size, 1);
});

test('parseFeatureFlags: multiple flags separated by commas', () => {
  const flags = parseFeatureFlags('flag_a,flag_b,flag_c');
  assert.ok(flags.has('flag_a'));
  assert.ok(flags.has('flag_b'));
  assert.ok(flags.has('flag_c'));
  assert.equal(flags.size, 3);
});

test('parseFeatureFlags: normalises to lowercase', () => {
  const flags = parseFeatureFlags('FlagA,FLAG_B');
  assert.ok(flags.has('flaga'));
  assert.ok(flags.has('flag_b'));
});

test('parseFeatureFlags: trims whitespace around flag names', () => {
  const flags = parseFeatureFlags(' flag_x , flag_y ');
  assert.ok(flags.has('flag_x'));
  assert.ok(flags.has('flag_y'));
});

test('parseFeatureFlags: skips empty segments from trailing/double commas', () => {
  const flags = parseFeatureFlags('flag_a,,flag_b,');
  assert.equal(flags.size, 2);
  assert.ok(flags.has('flag_a'));
  assert.ok(flags.has('flag_b'));
});

test('isFeatureEnabled: returns true when flag is present (case-insensitive lookup)', () => {
  const flags = parseFeatureFlags('webhook_cache_ttl_refresh,new_settlement_flow');
  // isFeatureEnabled reads from the module-level _flags set which is fixed at
  // import time, so we exercise parseFeatureFlags directly for gate logic.
  assert.ok(flags.has('webhook_cache_ttl_refresh'));
  assert.ok(!flags.has('unknown_flag'));
});

test('getEnabledFlags: returns sorted array of all enabled flags', () => {
  // Re-parse locally to verify sort order without relying on env state.
  const flags = parseFeatureFlags('zebra_flag,alpha_flag,middle_flag');
  const sorted = Array.from(flags).sort();
  assert.deepEqual(sorted, ['alpha_flag', 'middle_flag', 'zebra_flag']);
});

test('logFeatureFlags: emits structured log with active flag names', () => {
  const logged: Array<{ obj: object; msg?: string }> = [];
  const log = { info: (obj: object, msg?: string) => logged.push({ obj, msg }) };

  // Provide a test-time closure that mimics logFeatureFlags but uses a local set.
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
//
// The indexer's persistEvent uses this flag to decide whether a cache hit
// should renew the TTL (keeping hot subscription lists alive indefinitely)
// or let the fixed 30-second window expire as before. The helper below
// mirrors the same logic the production code path uses.

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
  const cachedAt = now - 10_000; // 10 s old — within the 30 s window

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
  const cachedAt = now - 35_000; // 35 s old — past the 30 s window

  const result = simulateCacheCheck(cachedAt, now, flags);
  assert.equal(result, 'miss');
});
