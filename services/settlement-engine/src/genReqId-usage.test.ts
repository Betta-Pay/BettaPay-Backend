import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Settlement Engine imports and uses shared registerRequestId plugin', (t) => {
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');
  
  t.ok(content.includes('registerRequestId'), 'index.ts should reference registerRequestId');
  t.match(content, /import\s+{[^}]*registerRequestId[^}]*}\s+from\s+['"]@bettapay\/validation['"]/s, 'index.ts should import registerRequestId from @bettapay/validation');
  t.match(content, /registerRequestId\(fastify\)/s, 'index.ts should call registerRequestId(fastify)');
  t.end();
});

test('Settlement Engine connects BullMQ through the shared Redis client', (t) => {
  // The shared createRedisClient factory (shared/validation/redis.ts) is
  // BullMQ-compatible: it sets maxRetriesPerRequest: null and configures an
  // explicit capped retryStrategy (verified in shared/validation/redis.test.ts).
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');

  t.match(content, /createRedisClient\(env\.REDIS_URL/s, 'creates Redis via the shared createRedisClient factory');
  t.match(content, /connection:\s*redis/s, 'BullMQ queues and workers connect through the shared client');
  t.end();
});
