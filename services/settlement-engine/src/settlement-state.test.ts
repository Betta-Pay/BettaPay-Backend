import test from 'tape';
import { prisma, SettlementStatusTransitions, validateTransition, closeTestResources } from './index.js';

test('Settlement state machine: validates correct transitions', (t) => {
  t.doesNotThrow(() => {
    validateTransition('pending', 'processing');
  }, 'allows pending -> processing');

  t.doesNotThrow(() => {
    validateTransition('pending', 'failed');
  }, 'allows pending -> failed');

  t.doesNotThrow(() => {
    validateTransition('processing', 'completed');
  }, 'allows processing -> completed');

  t.doesNotThrow(() => {
    validateTransition('processing', 'failed');
  }, 'allows processing -> failed');

  t.doesNotThrow(() => {
    validateTransition('completed', 'completed');
  }, 'allows identical status updates (idempotent)');

  t.end();
});

test('Settlement state machine: rejects invalid transitions', (t) => {
  t.throws(() => {
    validateTransition('pending', 'completed');
  }, /Invalid status transition/, 'rejects pending -> completed');

  t.throws(() => {
    validateTransition('completed', 'processing');
  }, /Invalid status transition/, 'rejects completed -> processing');

  t.throws(() => {
    validateTransition('failed', 'processing');
  }, /Invalid status transition/, 'rejects failed -> processing');

  t.end();
});

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
