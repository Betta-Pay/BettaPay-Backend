/**
 * Issue #1055 — Disallow allowHttp: true on rpc.Server in production.
 */

process.env.NODE_ENV = 'test';
process.env.METRICS_PORT = '0';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-service-secret-value';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(32);

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { createRpcServerOptions } = await import('./index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('#1055: createRpcServerOptions sets allowHttp: false in production', (t) => {
  const opts = createRpcServerOptions('production');
  t.equal(opts.allowHttp, false, 'allowHttp is false when NODE_ENV is production');
  t.end();
});

test('#1055: createRpcServerOptions allows HTTP in development and test environments', (t) => {
  t.equal(createRpcServerOptions('development').allowHttp, true, 'allowHttp is true in development');
  t.equal(createRpcServerOptions('test').allowHttp, true, 'allowHttp is true in test');
  t.equal(createRpcServerOptions(undefined).allowHttp, true, 'allowHttp is true when NODE_ENV is undefined');
  t.end();
});

test('#1055: index.ts does not hardcode allowHttp: true on rpc.Server', (t) => {
  const indexContent = fs.readFileSync(path.resolve(__dirname, './index.ts'), 'utf-8');
  t.equal(
    /new rpc\.Server\([^)]*allowHttp:\s*true/.test(indexContent),
    false,
    'rpc.Server does not hardcode allowHttp: true',
  );
  t.ok(
    indexContent.includes('createRpcServerOptions(env.NODE_ENV)'),
    'rpc.Server uses createRpcServerOptions(env.NODE_ENV)',
  );
  t.end();
});
