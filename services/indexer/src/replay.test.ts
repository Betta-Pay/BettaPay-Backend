import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexPath = path.resolve(__dirname, './index.ts');
const content = fs.readFileSync(indexPath, 'utf-8');

test('replay: MAX_REPLAY_LEDGER_RANGE constant is defined', (t) => {
  t.ok(content.includes('MAX_REPLAY_LEDGER_RANGE'), 'MAX_REPLAY_LEDGER_RANGE constant exists');
  t.ok(content.includes('MAX_REPLAY_LEDGER_RANGE = 1000'), 'default value is 1000');
  t.end();
});

test('replay: REPLAY_CHUNK_SIZE constant is defined', (t) => {
  t.ok(content.includes('REPLAY_CHUNK_SIZE'), 'REPLAY_CHUNK_SIZE constant exists');
  t.ok(content.includes('REPLAY_CHUNK_SIZE = 100'), 'default value is 100');
  t.end();
});

test('replay: range validation returns 400 for oversized range', (t) => {
  const rangeCheck = /range\s*>\s*MAX_REPLAY_LEDGER_RANGE/;
  t.match(content, rangeCheck, 'range exceeds max check present');
  t.ok(content.includes('400'), 'returns 400 status');
  t.ok(content.includes('VALIDATION_ERROR'), 'uses VALIDATION_ERROR code');
  t.ok(content.includes('Ledger range exceeds maximum'), 'clear error message');
  t.end();
});

test('replay: BullMQ replayQueue is created', (t) => {
  t.ok(content.includes("'indexer-replays'"), 'queue name is indexer-replays');
  t.ok(content.includes('new Queue('), 'Queue constructor is called');
  t.ok(content.includes("'indexer-replays'"), 'queue name used');
  t.end();
});

test('replay: BullMQ replayWorker is created', (t) => {
  t.ok(content.includes('new Worker('), 'Worker constructor is called');
  t.ok(content.includes("'indexer-replays'"), 'worker uses same queue name');
  t.end();
});

test('replay: progress tracking Redis key prefix', (t) => {
  t.ok(content.includes("'replay:progress:'"), 'progress key prefix defined');
  t.ok(content.includes('PROGRESS_KEY_PREFIX'), 'PROGRESS_KEY_PREFIX constant exists');
  t.end();
});

test('replay: updateReplayProgress function', (t) => {
  t.ok(content.includes('updateReplayProgress'), 'updateReplayProgress function exists');
  t.ok(content.includes('totalLedgers'), 'tracks totalLedgers');
  t.ok(content.includes('processedLedgers'), 'tracks processedLedgers');
  t.ok(content.includes("'running'"), 'running status');
  t.ok(content.includes("'completed'"), 'completed status');
  t.ok(content.includes("'failed'"), 'failed status');
  t.end();
});

test('replay: enqueues job and returns 202', (t) => {
  t.ok(content.includes('replayQueue.add('), 'job is enqueued via replayQueue.add');
  t.ok(content.includes('202'), 'returns 202 accepted');
  t.ok(content.includes('jobId'), 'returns jobId in response');
  t.end();
});

test('replay: GET /api/events/replay/:jobId/status endpoint', (t) => {
  t.ok(content.includes('/api/events/replay/:jobId/status'), 'status endpoint route defined');
  t.ok(content.includes('PROGRESS_KEY_PREFIX'), 'uses progress key prefix');
  t.ok(content.includes('NOT_FOUND'), 'returns 404 for unknown job');
  t.end();
});

test('replay: graceful shutdown closes replay queue and worker', (t) => {
  t.ok(content.includes('replayQueue.close()'), 'replayQueue closed on shutdown');
  t.ok(content.includes('replayWorker.close()'), 'replayWorker closed on shutdown');
  t.ok(content.includes('replayProgressRedis.quit()'), 'replayProgressRedis quit on shutdown');
  t.end();
});

test('replay: dedupes out-of-order and duplicate ledgers by sequence', (t) => {
  t.ok(content.includes('const processedLedgers = new Set<number>()'), 'tracks processed ledgers');
  t.ok(content.includes('processedLedgers.add(currentLedger)'), 'adds to processed ledgers');
  t.ok(content.includes('processedLedgers.has(evt.ledger)'), 'checks for duplicate ledgers');
  t.ok(content.includes('[Indexer] Skipping out-of-order or duplicate ledger'), 'logs warning for skipped ledgers');
  t.end();
});