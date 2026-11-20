import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeatureFlags,
  isFeatureEnabled,
  getEnabledFlags,
  logFeatureFlags,
  reloadFeatureFlags,
  analyzeFeatureFlags,
  KNOWN_FEATURE_FLAGS,
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

// ── Issue #1085: unknown / malformed flag warnings ───────────────────────────

function withFeatureFlags(value: string | undefined, fn: () => void): void {
  const prev = process.env.FEATURE_FLAGS;
  try {
    if (value === undefined) delete process.env.FEATURE_FLAGS;
    else process.env.FEATURE_FLAGS = value;
    reloadFeatureFlags();
    fn();
  } finally {
    if (prev !== undefined) process.env.FEATURE_FLAGS = prev;
    else delete process.env.FEATURE_FLAGS;
    reloadFeatureFlags();
  }
}

function createLogSpy() {
  const info: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  const warn: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  return {
    info,
    warn,
    log: {
      info: (obj: object, msg?: string) => info.push({ obj: obj as Record<string, unknown>, msg }),
      warn: (obj: object, msg?: string) => warn.push({ obj: obj as Record<string, unknown>, msg }),
    },
  };
}

test('KNOWN_FEATURE_FLAGS lists every flag checked in code', () => {
  assert.ok(KNOWN_FEATURE_FLAGS.has('webhook_cache_ttl_refresh'));
});

test('analyzeFeatureFlags: known valid flags parse unchanged with no diagnostics', () => {
  const result = analyzeFeatureFlags(' Webhook_Cache_TTL_Refresh ');
  assert.deepEqual(Array.from(result.flags), ['webhook_cache_ttl_refresh']);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.invalid, []);
});

test('analyzeFeatureFlags: unknown flag names are enabled but reported', () => {
  const result = analyzeFeatureFlags('webhook_cache_ttl_refresh,webhok_cache_ttl_refresh,zeta,alpha');
  assert.ok(result.flags.has('webhok_cache_ttl_refresh'), 'unknown flags are not dropped');
  assert.deepEqual(result.unknown, ['alpha', 'webhok_cache_ttl_refresh', 'zeta']);
  assert.deepEqual(result.invalid, []);
});

test('analyzeFeatureFlags: explicit boolean values enable or disable flags', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' On ']) {
    const result = analyzeFeatureFlags(`webhook_cache_ttl_refresh=${v}`);
    assert.ok(result.flags.has('webhook_cache_ttl_refresh'), `value "${v}" enables`);
    assert.deepEqual(result.invalid, []);
  }
  for (const v of ['false', 'FALSE', '0', 'no', 'off']) {
    const result = analyzeFeatureFlags(`webhook_cache_ttl_refresh=${v}`);
    assert.equal(result.flags.has('webhook_cache_ttl_refresh'), false, `value "${v}" disables`);
    assert.deepEqual(result.invalid, []);
  }
  // A later false overrides an earlier bare enable.
  assert.equal(analyzeFeatureFlags('webhook_cache_ttl_refresh,webhook_cache_ttl_refresh=off').flags.size, 0);
});

test('analyzeFeatureFlags: invalid boolean values and missing names are reported and never enable', () => {
  const result = analyzeFeatureFlags('webhook_cache_ttl_refresh=maybe,=true,other=');
  assert.equal(result.flags.size, 0);
  assert.deepEqual(result.invalid, [
    { entry: 'webhook_cache_ttl_refresh=maybe', reason: 'invalid_value' },
    { entry: '=true', reason: 'missing_name' },
    { entry: 'other=', reason: 'invalid_value' },
  ]);
  assert.deepEqual(result.unknown, []);
});

test('analyzeFeatureFlags: accepts a custom known-flag registry', () => {
  const result = analyzeFeatureFlags('a,b', new Set(['a']));
  assert.deepEqual(result.unknown, ['b']);
});

test('logFeatureFlags: warns with a structured payload for unknown flags', () => {
  withFeatureFlags('webhook_cache_ttl_refresh,webhok_cache_ttl_refresh', () => {
    const spy = createLogSpy();
    logFeatureFlags(spy.log);

    assert.equal(spy.info.length, 1);
    assert.deepEqual(spy.info[0].obj.flags, ['webhok_cache_ttl_refresh', 'webhook_cache_ttl_refresh']);
    assert.equal(spy.warn.length, 1);
    assert.match(spy.warn[0].msg ?? '', /Unknown feature flags/);
    assert.deepEqual(spy.warn[0].obj.unknownFlags, ['webhok_cache_ttl_refresh']);
    assert.deepEqual(spy.warn[0].obj.knownFlags, Array.from(KNOWN_FEATURE_FLAGS).sort());
  });
});

test('logFeatureFlags: warns with a structured payload for malformed entries', () => {
  withFeatureFlags('webhook_cache_ttl_refresh=yes please', () => {
    const spy = createLogSpy();
    logFeatureFlags(spy.log);

    assert.equal(spy.info[0].msg, 'No feature flags enabled');
    assert.equal(spy.warn.length, 1);
    assert.match(spy.warn[0].msg ?? '', /malformed/);
    assert.deepEqual(spy.warn[0].obj.invalidFlags, [
      { entry: 'webhook_cache_ttl_refresh=yes please', reason: 'invalid_value' },
    ]);
  });
});

test('logFeatureFlags: no warning for known, valid flags', () => {
  withFeatureFlags('webhook_cache_ttl_refresh=true', () => {
    const spy = createLogSpy();
    logFeatureFlags(spy.log);
    assert.equal(spy.info[0].msg, 'Feature flags active');
    assert.equal(spy.warn.length, 0);
    assert.equal(isFeatureEnabled('webhook_cache_ttl_refresh'), true);
  });
});

test('logFeatureFlags: loggers without warn still work', () => {
  withFeatureFlags('typo_flag', () => {
    const info: string[] = [];
    assert.doesNotThrow(() => logFeatureFlags({ info: (_obj, msg) => info.push(msg ?? '') }));
    assert.deepEqual(info, ['Feature flags active']);
  });
});
