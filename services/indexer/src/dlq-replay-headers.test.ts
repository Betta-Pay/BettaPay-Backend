import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexPath = path.resolve(__dirname, './index.ts');
const content = fs.readFileSync(indexPath, 'utf-8');

/**
 * Issue #614: replaying a dead-lettered webhook delivery re-enqueues it with
 * only url/event/signingSecret, dropping the custom headers
 * (Authorization, X-Idempotency-Key, ...) that job.data carried in from
 * dispatchPendingWebhookDeliveries. The merchant then rejects the retried
 * delivery for missing auth. Mirrors the source-text assertion style already
 * used by replay.test.ts for this same route-in-closure code.
 */

function extractReplayRouteBody(source: string): string {
  const routeStart = source.indexOf('"/api/admin/webhooks/dead-letter/:id/replay"');
  if (routeStart === -1) {
    throw new Error('dead-letter replay route not found in services/indexer/src/index.ts');
  }
  const addCallStart = source.indexOf('webhookQueue.add("deliver"', routeStart);
  const addCallEnd = source.indexOf(');', addCallStart);
  return source.slice(addCallStart, addCallEnd);
}

test('DLQ replay: re-enqueued job carries the original custom headers', (t) => {
  const replayEnqueueCall = extractReplayRouteBody(content);

  t.ok(
    /headers:\s*job\.data\.headers/.test(replayEnqueueCall),
    'replay re-enqueue forwards job.data.headers',
  );
  t.end();
});

test('DLQ replay: re-enqueued job still carries url, event, and signingSecret', (t) => {
  const replayEnqueueCall = extractReplayRouteBody(content);

  t.ok(/url:\s*job\.data\.url/.test(replayEnqueueCall), 'url is forwarded');
  t.ok(/event:\s*job\.data\.event/.test(replayEnqueueCall), 'event is forwarded');
  t.ok(
    /signingSecret:\s*job\.data\.signingSecret/.test(replayEnqueueCall),
    'signingSecret is forwarded',
  );
  t.end();
});
