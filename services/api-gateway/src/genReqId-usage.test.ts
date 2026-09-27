import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Verifies that the refactored index.ts still registers registerRequestId correctly.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('API Gateway imports and uses shared registerRequestId plugin', (t) => {
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');
  
  t.ok(content.includes('registerRequestId'), 'index.ts should reference registerRequestId');
  t.match(content, /import\s+{[^}]*registerRequestId[^}]*}\s+from\s+['"]@bettapay\/validation['"]/s, 'index.ts should import registerRequestId from @bettapay/validation');
  t.match(content, /registerRequestId\(fastify\)/s, 'index.ts should call registerRequestId(fastify)');
  t.end();
});

test('Error handler includes reqId in response body for correlation', (t) => {
  const pluginsPath = path.resolve(__dirname, '../../../shared/validation/plugins.ts');
  const content = fs.readFileSync(pluginsPath, 'utf-8');

  t.ok(
    content.includes("reqId") && content.includes("createErrorResponse(code, sanitizeErrorMessage(fastifyErr.message), details, reqId)"),
    'error handler should pass reqId to createErrorResponse',
  );
  t.end();
});
