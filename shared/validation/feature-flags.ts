/**
 * Feature flag support via the FEATURE_FLAGS environment variable.
 *
 * Flags are a comma-separated list of names, e.g.:
 *   FEATURE_FLAGS=new_settlement_flow,enhanced_fx_quotes
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
}

/**
 * Parse a raw FEATURE_FLAGS value into a normalised Set of flag names.
 * An undefined / empty value produces an empty Set (all flags disabled).
 */
export function parseFeatureFlags(raw: string | undefined): Set<string> {
  if (!raw || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f.length > 0),
  );
}

/**
 * Module-level singleton derived from process.env.FEATURE_FLAGS.
 * Re-read at module load time so it reflects the env state at startup.
 */
let _flags: Set<string> = parseFeatureFlags(process.env.FEATURE_FLAGS);

/**
 * Reloads the module-level feature flag set from process.env.FEATURE_FLAGS.
 */
export function reloadFeatureFlags(): void {
  _flags = parseFeatureFlags(process.env.FEATURE_FLAGS);
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
}
