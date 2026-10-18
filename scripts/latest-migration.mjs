#!/usr/bin/env node
/**
 * Deterministic "latest migration" selector (#846).
 *
 * The CI rollback job needs to know which Prisma migration was applied last.
 * A lexicographic `ls | sort | tail -1` is not good enough: it happily picks a
 * stray non-timestamped directory, and it cannot tell a malformed migration
 * name apart from a valid one. This script instead:
 *
 *   - considers only directories, so `migration_lock.toml` (and any other
 *     stray file) is ignored,
 *   - parses the leading 14-digit timestamp from each directory name,
 *   - orders entries by numeric timestamp, breaking ties on the full name so
 *     two migrations sharing a timestamp prefix still resolve deterministically,
 *   - fails loudly (exit 1) when a directory name does not look like a
 *     migration, instead of silently guessing.
 *
 * Usage:
 *   node scripts/latest-migration.mjs [migrations-dir]
 *   node scripts/latest-migration.mjs --self-check [migrations-dir]
 *
 * `[migrations-dir]` defaults to `prisma/migrations` relative to the working
 * directory. Default mode prints only the latest migration directory name, so
 * it can be captured in a shell substitution. `--self-check` re-derives the
 * selection with an independent ordering, asserts it matches, and prints a
 * summary of every migration considered.
 *
 * Exit status: 0 on success, 1 on malformed input or a failed self-check.
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Prisma migration folders look like `<14-digit timestamp>_<name>`. */
const MIGRATION_NAME_PATTERN = /^(\d{14})_(.+)$/;

const USAGE = [
  'Usage:',
  '  node scripts/latest-migration.mjs [migrations-dir]',
  '  node scripts/latest-migration.mjs --self-check [migrations-dir]',
].join('\n');

function fail(message) {
  console.error(`[latest-migration] ERROR: ${message}`);
  process.exit(1);
}

/**
 * Read the migration directories and parse their timestamps.
 * @param {string} dir Absolute path to the migrations directory.
 * @returns {Array<{ name: string, timestamp: bigint, paddedTimestamp: string }>}
 */
function readMigrations(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read migrations directory "${dir}": ${err.message}`);
  }

  // Only directories are migrations; files such as migration_lock.toml are
  // metadata and must not participate in selection.
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  if (names.length === 0) {
    fail(`no migration directories found in "${dir}"`);
  }

  const malformed = names.filter((name) => !MIGRATION_NAME_PATTERN.test(name));
  if (malformed.length > 0) {
    fail(
      [
        `${malformed.length} entr${malformed.length === 1 ? 'y' : 'ies'} under "${dir}" ` +
          'do not match the expected "<14-digit timestamp>_<name>" format:',
        ...malformed.map((name) => `  - ${name}`),
        'Refusing to guess the latest migration; rename or remove them.',
      ].join('\n'),
    );
  }

  return names.map((name) => {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    return { name, timestamp: BigInt(match[1]), paddedTimestamp: match[1] };
  });
}

/**
 * Order by numeric timestamp, then by full directory name. The name tie-break
 * is a plain code-unit comparison so the result is identical on every platform
 * and stable when two migrations share a timestamp prefix.
 */
function compareByTimestampThenName(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Independent ordering used by the self-check: compare the zero-padded
 * timestamp strings first, then the names. Zero-padded timestamps of equal
 * length sort lexicographically the same way they sort numerically, so this
 * agrees with the numeric comparator only if the selection is genuinely
 * correct.
 */
function compareByPaddedTimestampThenName(a, b) {
  if (a.paddedTimestamp !== b.paddedTimestamp) {
    return a.paddedTimestamp < b.paddedTimestamp ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function selectLatest(migrations) {
  const sorted = [...migrations].sort(compareByTimestampThenName);
  return { latest: sorted[sorted.length - 1], sorted };
}

function runSelfCheck(migrations, dir) {
  const { latest, sorted } = selectLatest(migrations);
  const independentlySorted = [...migrations].sort(compareByPaddedTimestampThenName);
  const independentlyExpected = independentlySorted[independentlySorted.length - 1];
  const maxTimestamp = migrations.reduce(
    (max, migration) => (migration.timestamp > max ? migration.timestamp : max),
    migrations[0].timestamp,
  );

  const problems = [];
  if (latest.name !== independentlyExpected.name) {
    problems.push(
      `numeric ordering selected "${latest.name}" but the independent ` +
        `ordering selected "${independentlyExpected.name}"`,
    );
  }
  if (latest.timestamp !== maxTimestamp) {
    problems.push(
      `selected timestamp ${latest.paddedTimestamp} is not the maximum ` +
        `(${maxTimestamp.toString()})`,
    );
  }
  if (problems.length > 0) {
    fail(['self-check failed for the latest-migration selector:', ...problems.map((p) => `  - ${p}`)].join('\n'));
  }

  console.log(
    `[latest-migration] self-check: ${migrations.length} migration ` +
      `director${migrations.length === 1 ? 'y' : 'ies'} in "${dir}", all conforming`,
  );
  for (const migration of sorted) {
    console.log(`[latest-migration]   ${migration.paddedTimestamp}  ${migration.name}`);
  }
  console.log(
    `[latest-migration] selected: ${latest.name} (timestamp ${latest.paddedTimestamp})`,
  );
  console.log('[latest-migration] OK: selected migration is the numeric maximum');
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const helpRequested = args.includes('--help');
  const selfCheckRequested = args.includes('--self-check');

  const unknownOptions = args.filter((arg) => arg.startsWith('--') && arg !== '--self-check' && arg !== '--help');
  if (unknownOptions.length > 0) {
    fail(`unknown option(s): ${unknownOptions.join(', ')}\n${USAGE}`);
  }
  if (helpRequested) {
    console.log(USAGE);
    return 0;
  }

  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) {
    fail(`expected at most one migrations directory, received ${positional.length}\n${USAGE}`);
  }

  const dir = resolve(positional[0] ?? 'prisma/migrations');
  const migrations = readMigrations(dir);

  if (selfCheckRequested) {
    return runSelfCheck(migrations, dir);
  }

  const { latest } = selectLatest(migrations);
  process.stdout.write(`${latest.name}\n`);
  return 0;
}

process.exit(main(process.argv));
