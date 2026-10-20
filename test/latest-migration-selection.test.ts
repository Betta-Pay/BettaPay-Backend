/**
 * Pins the behavior of scripts/latest-migration.mjs (#846).
 *
 * The CI rollback job uses this selector to decide which migration to roll
 * back, so it has to be deterministic and loud about bad input. These tests
 * cover the cases a lexicographic `ls | sort | tail -1` gets wrong:
 * collisions on a shared timestamp prefix, stray files/directories, and
 * malformed migration names.
 */
import test from 'tape';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = join(REPO_ROOT, 'scripts', 'latest-migration.mjs');

interface SelectorResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runSelector(dir: string, extraArgs: string[] = []): SelectorResult {
  try {
    const stdout = execFileSync(process.execPath, [SELECTOR, ...extraArgs, dir], {
      encoding: 'utf8',
    });
    return { ok: true, stdout: stdout.trim(), stderr: '', status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number | null };
    return {
      ok: false,
      stdout: String(failure.stdout ?? '').trim(),
      stderr: String(failure.stderr ?? '').trim(),
      status: failure.status ?? null,
    };
  }
}

/** Build a throwaway directory that looks like prisma/migrations. */
function makeFixture(entries: string[], extraFiles: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'latest-migration-fixture-'));
  // Real migrations directories always contain this metadata file; it is not
  // a directory and must never be treated as a migration.
  writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');
  for (const entry of entries) {
    mkdirSync(join(dir, entry));
  }
  for (const file of extraFiles) {
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

function removeFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('selects the migration with the greatest numeric timestamp', (t) => {
  const dir = makeFixture([
    '20260924000000_add_settlement_batchid_index',
    '20250101000000_init',
    '20260728111000_add_settlement_retry',
  ]);
  try {
    const result = runSelector(dir);
    t.ok(result.ok, 'selector exits successfully');
    t.equal(
      result.stdout,
      '20260924000000_add_settlement_batchid_index',
      'latest migration by numeric timestamp is selected',
    );
  } finally {
    removeFixture(dir);
  }
  t.end();
});

test('resolves shared timestamp prefixes deterministically', (t) => {
  // The repository itself has several of these pairs; a lexicographic tail
  // silently picks one without any stated rule. The selector must order them
  // by full directory name and stay stable regardless of read order.
  const entries = [
    '20260728120000_add_composite_unique_indexed_event',
    '20260728120000_add_merchant_status',
  ];
  const forwardDir = makeFixture(entries);
  const reversedDir = makeFixture([...entries].reverse());
  try {
    const first = runSelector(forwardDir);
    const second = runSelector(forwardDir);
    const reversed = runSelector(reversedDir);

    t.ok(first.ok, 'selector exits successfully');
    t.equal(first.stdout, '20260728120000_add_merchant_status', 'name ordering breaks the tie');
    t.equal(first.stdout, second.stdout, 'repeated runs are stable');
    t.equal(first.stdout, reversed.stdout, 'directory read order does not matter');

    const selfCheck = runSelector(forwardDir, ['--self-check']);
    t.ok(selfCheck.ok, 'self-check passes on colliding prefixes');
    t.ok(selfCheck.stdout.includes(first.stdout), 'self-check reports the selected migration');
  } finally {
    removeFixture(forwardDir);
    removeFixture(reversedDir);
  }
  t.end();
});

test('ignores files that sort after timestamps', (t) => {
  const dir = makeFixture(['20250101000000_init'], ['zzz_notes.txt']);
  try {
    const result = runSelector(dir);
    t.ok(result.ok, 'selector exits successfully');
    t.equal(result.stdout, '20250101000000_init', 'the only migration is selected');
  } finally {
    removeFixture(dir);
  }
  t.end();
});

test('errors clearly on malformed migration directory names', (t) => {
  const dir = makeFixture(['20250101000000_ok', 'backup_notes']);
  try {
    const result = runSelector(dir);
    t.equal(result.ok, false, 'selector exits non-zero');
    t.equal(result.status, 1, 'exit status is 1');
    t.equal(result.stdout, '', 'nothing is written to stdout');
    t.ok(result.stderr.includes('backup_notes'), 'error names the offending directory');
    t.ok(result.stderr.includes('14-digit timestamp'), 'error explains the expected format');
  } finally {
    removeFixture(dir);
  }
  t.end();
});

test('errors clearly when a migration directory has no name suffix', (t) => {
  const dir = makeFixture(['20250101000000_ok', '20260728120000']);
  try {
    const result = runSelector(dir);
    t.equal(result.ok, false, 'selector exits non-zero');
    t.equal(result.status, 1, 'exit status is 1');
    t.ok(result.stderr.includes('20260728120000'), 'error names the offending directory');
  } finally {
    removeFixture(dir);
  }
  t.end();
});

test('errors when there are no migration directories at all', (t) => {
  const dir = makeFixture([]);
  try {
    const result = runSelector(dir);
    t.equal(result.ok, false, 'selector exits non-zero');
    t.equal(result.status, 1, 'exit status is 1');
    t.ok(result.stderr.includes('no migration directories'), 'error explains the problem');
  } finally {
    removeFixture(dir);
  }
  t.end();
});

test('self-check accepts the real prisma/migrations directory', (t) => {
  const migrationsDir = join(REPO_ROOT, 'prisma', 'migrations');
  const selected = runSelector(migrationsDir);
  const selfCheck = runSelector(migrationsDir, ['--self-check']);

  t.ok(selected.ok, 'selector exits successfully on the real migrations directory');
  t.ok(selfCheck.ok, 'self-check exits successfully on the real migrations directory');
  t.ok(
    selfCheck.stdout.includes(selected.stdout),
    'self-check reports the same migration as the selector',
  );
  t.end();
});
