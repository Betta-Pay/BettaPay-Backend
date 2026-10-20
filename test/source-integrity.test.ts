/**
 * test/source-integrity.test.ts
 *
 * Tests verifying the repository source integrity checks:
 * 1. Fails when conflict-artifact tokens appear in source files.
 * 2. Fails when duplicated import specifiers appear within a single file.
 * 3. Passes on the clean codebase.
 */

import test from 'tape';
import {
  checkConflictArtifacts,
  checkDuplicateImports,
  runChecks,
} from '../scripts/check-source-integrity.mjs';

test('source integrity: detects upstream/main and conflict markers', (t) => {
  const fileWithBranchToken = `
import Fastify from 'fastify';
upstream/main
import { something } from './local.js';
`;

  const errors1 = checkConflictArtifacts('/path/to/src/index.ts', fileWithBranchToken);
  t.equal(errors1.length, 1, 'should detect upstream/main token');
  t.equal(errors1[0].token, 'upstream/main');

  const fileWithConflictMarker = `
<<<<<<< HEAD
import { foo } from './foo.js';
=======
import { bar } from './bar.js';
>>>>>>> upstream/main
`;

  const errors2 = checkConflictArtifacts('/path/to/src/worker.ts', fileWithConflictMarker);
  t.equal(errors2.length, 3, 'should detect all conflict marker lines');
  t.equal(errors2[0].token, '<<<<<<<');
  t.equal(errors2[1].token, '=======');
  t.equal(errors2[2].token, '>>>>>>>');

  const cleanFile = `
import Fastify from 'fastify';
// Normal comment
export const x = 1;
`;
  const cleanErrors = checkConflictArtifacts('/path/to/src/clean.ts', cleanFile);
  t.equal(cleanErrors.length, 0, 'clean file should have 0 conflict errors');

  t.end();
});

test('source integrity: detects duplicated import specifiers within a single file', (t) => {
  const fileWithDupe = `
import { closeWorkerWithTimeout, trackActiveJob } from './worker-shutdown.js';
import { closeWorkerWithTimeout } from './worker-shutdown.js';
`;

  const errors1 = checkDuplicateImports('/path/to/src/index.ts', fileWithDupe);
  t.equal(errors1.length, 1, 'should detect duplicated import specifier');
  t.equal(errors1[0].symbol, 'closeWorkerWithTimeout');

  const fileWithMultiDupe = `
import { closeWorkerWithTimeout, trackActiveJob } from './worker-shutdown.js';
import { trackActiveJob } from './other.js';
`;

  const errors2 = checkDuplicateImports('/path/to/src/index.ts', fileWithMultiDupe);
  t.equal(errors2.length, 1, 'should detect trackActiveJob duplicated across import lines');
  t.equal(errors2[0].symbol, 'trackActiveJob');

  const fileWithSameLineDupe = `
import { closeWorkerWithTimeout, closeWorkerWithTimeout } from './worker-shutdown.js';
`;
  const errors3 = checkDuplicateImports('/path/to/src/index.ts', fileWithSameLineDupe);
  t.equal(errors3.length, 1, 'should detect symbol duplicated on same import line');

  const cleanImports = `
import { closeWorkerWithTimeout, trackActiveJob } from './worker-shutdown.js';
import { validateTimeoutConstants } from './timeout-constants.js';
import { startSettlementReaper } from './settlement-reaper.js';
`;
  const cleanErrors = checkDuplicateImports('/path/to/src/clean.ts', cleanImports);
  t.equal(cleanErrors.length, 0, 'clean imports should have 0 duplicate errors');

  t.end();
});

test('source integrity: full repository scan passes with zero errors', (t) => {
  const { conflictErrors, duplicateImportErrors } = runChecks();
  t.equal(conflictErrors.length, 0, 'repository should have zero conflict-artifact errors');
  t.equal(duplicateImportErrors.length, 0, 'repository should have zero duplicate import errors');
  t.end();
});
