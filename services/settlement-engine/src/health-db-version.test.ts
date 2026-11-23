import test from 'tape';
import { fastify, prisma, redis, settlementQueue, closeTestResources } from './index.js';

process.env.NODE_ENV = 'test';

const PG_VERSION = 'PostgreSQL 16.2 (Debian 16.2-1.pgdg120+2) on x86_64-pc-linux-gnu';

type Stubbed = { obj: any; key: string; original: unknown };

function stub(stubs: Stubbed[], obj: any, key: string, value: unknown) {
  stubs.push({ obj, key, original: obj[key] });
  obj[key] = value;
}

function restore(stubs: Stubbed[]) {
  for (const s of stubs.reverse()) s.obj[s.key] = s.original;
}

function stubHealthyDeps(stubs: Stubbed[]) {
  stub(stubs, redis, 'ping', async () => 'PONG');
  stub(stubs, settlementQueue, 'getJobCounts', async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }));
  stub(stubs, settlementQueue, 'isPaused', async () => false);
}

test('/api/health reports the PostgreSQL version() output, not NOW()', async (t) => {
  const stubs: Stubbed[] = [];
  let sql = '';
  stubHealthyDeps(stubs);
  stub(stubs, prisma, '$queryRaw', async (strings: TemplateStringsArray) => {
    sql = strings.join('?');
    return [{ serverVersion: PG_VERSION }];
  });

  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/health' });
    t.equal(res.statusCode, 200, 'returns 200 when dependencies are healthy');

    const body = JSON.parse(res.body);
    const pg = body.dependencies.find((d: { name: string }) => d.name === 'postgresql');
    t.equal(pg.status, 'connected', 'postgresql is connected');
    t.equal(pg.details.serverVersion, PG_VERSION, 'serverVersion is the database version string');
    t.ok(/version\(\)/i.test(sql), 'health query calls version()');
    t.notOk(/now\(\)/i.test(sql), 'health query no longer uses NOW()');
  } finally {
    restore(stubs);
  }
  t.end();
});

test('/api/health handles database errors gracefully', async (t) => {
  const stubs: Stubbed[] = [];
  stubHealthyDeps(stubs);
  stub(stubs, prisma, '$queryRaw', async () => {
    throw new Error('connection refused');
  });

  try {
    const res = await fastify.inject({ method: 'GET', url: '/api/health' });
    t.equal(res.statusCode, 503, 'returns 503 instead of throwing');

    const body = JSON.parse(res.body);
    const pg = body.dependencies.find((d: { name: string }) => d.name === 'postgresql');
    t.equal(pg.status, 'disconnected', 'postgresql is reported disconnected');
    t.equal(pg.details.error, 'connection refused', 'error message is surfaced');
    t.notOk(pg.details.serverVersion, 'no version is reported');
  } finally {
    restore(stubs);
  }
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
