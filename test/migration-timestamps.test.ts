import test from 'tape';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(process.cwd(), 'prisma', 'migrations');

function getMigrationFolders() {
  return readdirSync(migrationsDir)
    .filter((entry) => {
      const fullPath = join(migrationsDir, entry);
      return statSync(fullPath).isDirectory();
    })
    .filter((entry) => entry !== 'migration_lock.toml');
}

test('migration directories have unique sortable timestamp prefixes', (t) => {
  const folders = getMigrationFolders();
  const timestamps = folders.map((folder) => {
    const match = folder.match(/^(\d{14})_/);
    if (!match) {
      throw new Error(`Migration folder name does not start with a 14-digit timestamp: ${folder}`);
    }
    return match[1];
  });

  const uniqueTimestamps = new Set(timestamps);
  t.equal(uniqueTimestamps.size, timestamps.length, 'each migration timestamp prefix is unique');

  const sorted = [...timestamps].sort();
  t.deepEqual(sorted, timestamps, 'timestamp prefixes sort in authored order');
  t.end();
});
