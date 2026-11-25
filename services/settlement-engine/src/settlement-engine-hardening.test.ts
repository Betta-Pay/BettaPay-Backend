/**
 * Settlement Engine Hardening Tests
 *
 * Verifies the 4 critical security, reliability, and conformance issues:
 * - #1026: Query PostgreSQL version() in settlement-engine /api/health
 * - #1027: Enforce serviceAuth on settlement-engine internal mutation and reconcile routes
 * - #1028: Clean up orphaned newSettlement on VersionConflictError in retry route
 * - #1029: Block suspended merchants in settlement-engine create and retry routes
 */
import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, './index.ts');
const indexContent = fs.readFileSync(indexPath, 'utf-8');

// ─── #1026: Health Check PostgreSQL version() Query ─────────────────────────

test('#1026: /api/health queries version() instead of NOW()', (t) => {
  t.match(
    indexContent,
    /queryDatabase:\s*\(\)\s*=>\s*prisma\.\$queryRaw`SELECT 1, version\(\) AS "serverVersion"`/,
    '/api/health queryDatabase must use version() rather than NOW()',
  );
  t.ok(
    !/queryDatabase:\s*\(\)\s*=>\s*prisma\.\$queryRaw`SELECT 1, NOW\(\) AS "serverVersion"`/.test(indexContent),
    'must not query NOW() for serverVersion',
  );
  t.end();
});

// ─── #1027: serviceAuth Enforcement on Internal Routes ──────────────────────

test('#1027: POST /api/settlements enforces serviceAuth', (t) => {
  t.match(
    indexContent,
    /fastify\.post[\s\S]*?['"]\/api\/settlements['"],\s*\{[\s\S]*?preValidation:\s*\[fastify\.serviceAuth\]/,
    'POST /api/settlements must have preValidation: [fastify.serviceAuth]',
  );
  t.end();
});

test('#1027: POST /api/settlements/:id/retry enforces serviceAuth', (t) => {
  t.match(
    indexContent,
    /fastify\.post[\s\S]*?['"]\/api\/settlements\/:id\/retry['"],\s*\{[\s\S]*?preValidation:\s*\[fastify\.serviceAuth\]/,
    'POST /api/settlements/:id/retry must have preValidation: [fastify.serviceAuth]',
  );
  t.end();
});

test('#1027: GET /api/settlements/reconcile enforces serviceAuth', (t) => {
  t.match(
    indexContent,
    /fastify\.get[\s\S]*?['"]\/api\/settlements\/reconcile['"],\s*\{[\s\S]*?preValidation:\s*\[fastify\.serviceAuth\]/,
    'GET /api/settlements/reconcile must have preValidation: [fastify.serviceAuth]',
  );
  t.end();
});

test('#1027: GET /api/settlements/reconcile/report enforces serviceAuth', (t) => {
  t.match(
    indexContent,
    /fastify\.get[\s\S]*?['"]\/api\/settlements\/reconcile\/report['"],\s*\{[\s\S]*?preValidation:\s*\[fastify\.serviceAuth\]/,
    'GET /api/settlements/reconcile/report must have preValidation: [fastify.serviceAuth]',
  );
  t.end();
});

// ─── #1028: Orphaned newSettlement Cleanup on VersionConflictError ──────────

test('#1028: retry route performs compensating delete on VersionConflictError', (t) => {
  t.match(
    indexContent,
    /if\s*\(\s*err\s+instanceof\s+VersionConflictError\s*\)\s*\{[\s\S]*?prisma\.settlement\.delete\(\s*\{\s*where:\s*\{\s*id:\s*newSettlementId\s*\}\s*\}\s*\)/,
    'retry route must delete orphaned newSettlement on VersionConflictError',
  );
  t.match(
    indexContent,
    /if\s*\(\s*err\s+instanceof\s+VersionConflictError\s*\)\s*\{[\s\S]*?reply\.code\(409\)\.send\(/,
    'retry route must respond with HTTP 409 on version conflict',
  );
  t.end();
});

// ─── #1029: Block Suspended and Deleted Merchants ───────────────────────────

test('#1029: POST /api/settlements blocks suspended and deleted merchants with 403', (t) => {
  t.match(
    indexContent,
    /if\s*\(\s*merchant\.status\s*===\s*['"]suspended['"]\s*\|\|\s*merchant\.deletedAt\s*!==\s*null\s*\)\s*\{[\s\S]*?reply\.code\(403\)/,
    'POST /api/settlements must reject suspended or deleted merchants with HTTP 403',
  );
  t.end();
});

test('#1029: POST /api/settlements/:id/retry blocks suspended and deleted merchants with 403', (t) => {
  t.match(
    indexContent,
    /getCachedMerchant\(\s*original\.merchantId[\s\S]*?if\s*\(\s*merchant\.status\s*===\s*['"]suspended['"]\s*\|\|\s*merchant\.deletedAt\s*!==\s*null\s*\)\s*\{[\s\S]*?reply\.code\(403\)/,
    'POST /api/settlements/:id/retry must verify merchant status and reject suspended/deleted with HTTP 403',
  );
  t.end();
});
