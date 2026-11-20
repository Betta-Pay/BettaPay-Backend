/**
 * Feature flag support via the FEATURE_FLAGS environment variable.
 *
 * Flags are a comma-separated list of names, e.g.:
 *   FEATURE_FLAGS=new_settlement_flow,enhanced_fx_quotes
 *
 * An entry may also carry an explicit boolean value (#1085):
 *   FEATURE_FLAGS=webhook_cache_ttl_refresh=true,other_flag=off
 * Accepted values are true/false, 1/0, yes/no and on/off (case-insensitive).
 *
 * Lookup is O(1) via a Set built once from the raw env string. Flag names are
 * normalised to lowercase and trimmed so "New_Settlement_Flow " and
 * "new_settlement_flow" resolve to the same entry.
 *
 * Usage:
 *   import { isFeatureEnabled } from '@bettapay/validation';
 *   if (isFeatureEnabled('new_settlement_flow')) { ... }
 */

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn?: (obj: object, msg?: string) => void;
}

/**
 * Every flag name the codebase checks via isFeatureEnabled (#1085).
 * Add new flags here when introducing an isFeatureEnabled call so that a
 * typo in FEATURE_FLAGS surfaces as a startup warning instead of silently
 * leaving the flag disabled.
 */
export const KNOWN_FEATURE_FLAGS: ReadonlySet<string> = new Set([
  'webhook_cache_ttl_refresh',
]);

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

export interface InvalidFeatureFlag {
  /** The raw, trimmed entry as it appeared in FEATURE_FLAGS. */
  entry: string;
  reason: 'invalid_value' | 'missing_name';
}

export interface FeatureFlagParseResult {
  /** Normalised names of enabled flags. */
  flags: Set<string>;
  /** Enabled flag names that are not in the known-flag registry (sorted). */
  unknown: string[];
  /** Entries that could not be parsed; these never enable a flag. */
  invalid: InvalidFeatureFlag[];
}

/**
 * Parse a raw FEATURE_FLAGS value and report diagnostics (#1085).
 * Unknown names are still enabled (misconfiguration is not fatal) but are
 * listed in `unknown`; entries with an unrecognised boolean value or no name
 * are skipped and listed in `invalid`.
 */
export function analyzeFeatureFlags(
  raw: string | undefined,
  known: ReadonlySet<string> = KNOWN_FEATURE_FLAGS,
): FeatureFlagParseResult {
  const flags = new Set<string>();
  const invalid: InvalidFeatureFlag[] = [];
  if (!raw || raw.trim() === '') return { flags, unknown: [], invalid };

  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry.length === 0) continue;

    const eq = entry.indexOf('=');
    const name = (eq === -1 ? entry : entry.slice(0, eq)).trim().toLowerCase();
    if (name.length === 0) {
      invalid.push({ entry, reason: 'missing_name' });
      continue;
    }

    if (eq === -1) {
      flags.add(name);
      continue;
    }

    const value = entry.slice(eq + 1).trim().toLowerCase();
    if (TRUE_VALUES.has(value)) {
      flags.add(name);
    } else if (FALSE_VALUES.has(value)) {
      flags.delete(name);
    } else {
      invalid.push({ entry, reason: 'invalid_value' });
    }
  }

  const unknown = Array.from(flags)
    .filter((name) => !known.has(name))
    .sort();
  return { flags, unknown, invalid };
}

/**
 * Parse a raw FEATURE_FLAGS value into a normalised Set of flag names.
 * An undefined / empty value produces an empty Set (all flags disabled).
 */
export function parseFeatureFlags(raw: string | undefined): Set<string> {
  return analyzeFeatureFlags(raw).flags;
}

/**
 * Module-level singleton derived from process.env.FEATURE_FLAGS.
 * Re-read at module load time so it reflects the env state at startup.
 */
let _parsed: FeatureFlagParseResult = analyzeFeatureFlags(process.env.FEATURE_FLAGS);
let _flags: Set<string> = _parsed.flags;

/**
 * Reloads the module-level feature flag set from process.env.FEATURE_FLAGS.
 */
export function reloadFeatureFlags(): void {
  _parsed = analyzeFeatureFlags(process.env.FEATURE_FLAGS);
  _flags = _parsed.flags;
}

/**
 * Returns true when `name` appears in the FEATURE_FLAGS env var.
 * Name matching is case-insensitive.
 *
 * @example
 *   if (isFeatureEnabled('new_settlement_flow')) {
 *     // guarded code path
 *   }
 */
export function isFeatureEnabled(name: string): boolean {
  return _flags.has(name.trim().toLowerCase());
}

/**
 * Returns a sorted array of all currently enabled flag names.
 * Useful for startup logging and health-check responses.
 */
export function getEnabledFlags(): string[] {
  return Array.from(_flags).sort();
}

/**
 * Logs the current feature flag state at startup.
 * Emits a single structured log line listing all enabled flags (or noting
 * that none are active) so the deployed flag set is always visible in logs.
 * Unknown flag names and unparseable entries additionally emit a structured
 * warning (#1085) so typos are visible without failing startup.
 *
 * @example
 *   logFeatureFlags(app.log);
 *   // → {"flags":["new_settlement_flow"],"msg":"Feature flags active"}
 *   // → {"flags":[],"msg":"No feature flags enabled"}
 */
export function logFeatureFlags(log: MinimalLogger): void {
  const flags = getEnabledFlags();
  if (flags.length > 0) {
    log.info({ flags }, 'Feature flags active');
  } else {
    log.info({ flags }, 'No feature flags enabled');
  }

  if (!log.warn) return;
  if (_parsed.unknown.length > 0) {
    log.warn(
      { unknownFlags: _parsed.unknown, knownFlags: Array.from(KNOWN_FEATURE_FLAGS).sort() },
      'Unknown feature flags in FEATURE_FLAGS (possible typo)',
    );
  }
  if (_parsed.invalid.length > 0) {
    log.warn(
      { invalidFlags: _parsed.invalid },
      'Ignored malformed FEATURE_FLAGS entries',
    );
  }
}
