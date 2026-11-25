import test from 'tape';
import {
  checkDownstreamReadiness,
  checkServiceReadiness,
  type DownstreamService,
  type ServiceReadiness,
} from './downstream-readiness.js';

// ---------------------------------------------------------------------------
// Capability-aware readiness (Issue #556)
//
// A service is only "ready" when its /api/health ping AND a real capability
// endpoint both succeed with the expected contract. The capability probe is
// what catches schema/DB drift in a downstream that a bare ping would miss.
// ---------------------------------------------------------------------------

type MockFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

function makeFetch(routes: Record<string, () => Response>): { fetchImpl: MockFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: MockFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const route = routes[url];
    if (!route) throw new Error(`No mock route for ${url}`);
    return route();
  };
  return { fetchImpl, calls };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('ready when both ping and capability probes succeed, with per-service detail', async (t) => {
  const { fetchImpl, calls } = makeFetch({
    'http://fx:3002/api/health': () => new Response('ok', { status: 200 }),
    'http://fx:3002/api/currencies': () => okJson({ currencies: [{ code: 'USD', name: 'US Dollar' }] }),
  });

  const services: DownstreamService[] = [
    {
      name: 'fx-engine',
      healthUrl: 'http://fx:3002/api/health',
      capabilityUrl: 'http://fx:3002/api/currencies',
      validateBody: (body) =>
        typeof body === 'object' && body !== null && Array.isArray((body as { currencies?: unknown }).currencies),
    },
  ];

  const results = await checkDownstreamReadiness(services, { fetchImpl });

  t.equal(results.length, 1, 'one service checked');
  t.equal(results[0].ready, true, 'service is ready');
  t.ok(results[0].checkedAt, 'checkedAt timestamp present');
  t.equal(results[0].ping.ok, true, 'ping probe ok');
  t.equal(results[0].ping.endpoint, 'http://fx:3002/api/health', 'ping endpoint recorded');
  t.equal(results[0].capability.ok, true, 'capability probe ok');
  t.equal(results[0].capability.endpoint, 'http://fx:3002/api/currencies', 'capability endpoint recorded');
  t.equal(typeof results[0].capability.durationMs, 'number', 'capability durationMs present');

  t.equal(calls.length, 2, 'two probe calls made');
  for (const call of calls) {
    t.ok(call.headers['x-trace-id'], 'x-trace-id header present on every probe');
    t.ok(/^[0-9a-f-]+$/.test(call.headers['x-trace-id']), 'x-trace-id looks like a UUID');
  }

  t.end();
});

test('partial failure: ping ok but capability returns 500 — service NOT ready', async (t) => {
  const { fetchImpl } = makeFetch({
    'http://fx:3002/api/health': () => new Response('ok', { status: 200 }),
    'http://fx:3002/api/currencies': () => new Response('boom', { status: 500 }),
  });

  const services: DownstreamService[] = [
    {
      name: 'fx-engine',
      healthUrl: 'http://fx:3002/api/health',
      capabilityUrl: 'http://fx:3002/api/currencies',
      validateBody: () => true,
    },
  ];

  const results = await checkDownstreamReadiness(services, { fetchImpl });

  t.equal(results[0].ready, false, 'service is NOT ready even though ping succeeded');
  t.equal(results[0].ping.ok, true, 'ping probe still ok');
  t.equal(results[0].capability.ok, false, 'capability probe failed');
  t.equal(results[0].capability.statusCode, 500, 'capability failure statusCode recorded');
  t.match(results[0].capability.error ?? '', /HTTP 500/, 'capability error mentions HTTP 500');

  t.end();
});

test('partial failure: capability returns 200 with wrong contract (schema/DB drift) — NOT ready', async (t) => {
  // Ping works, endpoint is up, but the body no longer matches the expected
  // contract — exactly the schema/DB drift a bare health ping would miss.
  const { fetchImpl } = makeFetch({
    'http://fx:3002/api/health': () => new Response('ok', { status: 200 }),
    'http://fx:3002/api/currencies': () => okJson({ notCurrencies: true }),
  });

  const services: DownstreamService[] = [
    {
      name: 'fx-engine',
      healthUrl: 'http://fx:3002/api/health',
      capabilityUrl: 'http://fx:3002/api/currencies',
      validateBody: (body) =>
        typeof body === 'object' && body !== null && Array.isArray((body as { currencies?: unknown }).currencies),
    },
  ];

  const result = await checkServiceReadiness(services[0], { fetchImpl });

  t.equal(result.ready, false, 'service is NOT ready when capability contract is wrong');
  t.equal(result.ping.ok, true, 'ping probe still ok');
  t.equal(result.capability.ok, false, 'capability probe fails contract validation');
  t.equal(result.capability.statusCode, 200, 'capability was HTTP 200 but body invalid');
  t.match(result.capability.error ?? '', /expected contract/, 'error explains contract mismatch');

  t.end();
});

test('ping failure alone marks service not ready', async (t) => {
  const { fetchImpl } = makeFetch({
    'http://indexer:3003/api/health': () => {
      throw new Error('Connection refused');
    },
    'http://indexer:3003/api/events?limit=1': () => okJson({ data: [] }),
  });

  const services: DownstreamService[] = [
    {
      name: 'indexer',
      healthUrl: 'http://indexer:3003/api/health',
      capabilityUrl: 'http://indexer:3003/api/events?limit=1',
    },
  ];

  const results = await checkDownstreamReadiness(services, { fetchImpl });

  t.equal(results[0].ready, false, 'service is not ready when ping fails');
  t.equal(results[0].ping.ok, false, 'ping probe failed');
  t.match(results[0].ping.error ?? '', /Connection refused/, 'ping error recorded');

  t.end();
});

test('per-service readiness detail is logged: ready -> info, not ready -> warn', async (t) => {
  const { fetchImpl } = makeFetch({
    'http://fx:3002/api/health': () => new Response('ok', { status: 200 }),
    'http://fx:3002/api/currencies': () => okJson({ currencies: [] }),
    'http://indexer:3003/api/health': () => new Response('ok', { status: 200 }),
    'http://indexer:3003/api/events?limit=1': () => new Response('down', { status: 503 }),
  });

  const services: DownstreamService[] = [
    {
      name: 'fx-engine',
      healthUrl: 'http://fx:3002/api/health',
      capabilityUrl: 'http://fx:3002/api/currencies',
      validateBody: (body) =>
        typeof body === 'object' && body !== null && Array.isArray((body as { currencies?: unknown }).currencies),
    },
    {
      name: 'indexer',
      healthUrl: 'http://indexer:3003/api/health',
      capabilityUrl: 'http://indexer:3003/api/events?limit=1',
      validateBody: (body) =>
        typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data),
    },
  ];

  const infoLogs: { obj: unknown; msg?: string }[] = [];
  const warnLogs: { obj: unknown; msg?: string }[] = [];
  const logger = {
    info: (obj: unknown, msg?: string) => infoLogs.push({ obj, msg }),
    warn: (obj: unknown, msg?: string) => warnLogs.push({ obj, msg }),
  };

  const results = await checkDownstreamReadiness(services, { fetchImpl, logger });

  t.equal(results[0].ready, true, 'fx-engine ready');
  t.equal(results[1].ready, false, 'indexer not ready');
  t.equal(results[1].capability.statusCode, 503, 'indexer capability 503 recorded in result');

  t.equal(infoLogs.length, 1, 'one info log for the ready service');
  t.equal(warnLogs.length, 1, 'one warn log for the not-ready service');

  const infoLog = infoLogs[0].obj as ServiceReadiness;
  t.equal(infoLog.name, 'fx-engine', 'info log carries per-service detail');
  t.equal(infoLog.ping.ok && infoLog.capability.ok, true, 'info log shows both probes ok');

  const warnLog = warnLogs[0].obj as ServiceReadiness;
  t.equal(warnLog.name, 'indexer', 'warn log carries per-service detail');
  t.equal(warnLog.ready, false, 'warn log shows ready=false');
  t.equal(warnLog.ping.ok, true, 'warn log shows ping ok (partial failure)');
  t.equal(warnLog.capability.ok, false, 'warn log shows capability failed');

  t.end();
});

test('x-service-token is sent on capability probes that require it', async (t) => {
  const { fetchImpl, calls } = makeFetch({
    'http://indexer:3003/api/health': () => new Response('ok', { status: 200 }),
    'http://indexer:3003/api/events?limit=1': () => okJson({ data: [] }),
  });

  const services: DownstreamService[] = [
    {
      name: 'indexer',
      healthUrl: 'http://indexer:3003/api/health',
      capabilityUrl: 'http://indexer:3003/api/events?limit=1',
      serviceToken: 's3cret',
      validateBody: (body) =>
        typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data),
    },
  ];

  const results = await checkDownstreamReadiness(services, { fetchImpl });

  t.equal(results[0].ready, true, 'indexer ready with token');
  for (const call of calls) {
    t.equal(call.headers['x-service-token'], 's3cret', 'x-service-token sent on ' + call.url);
  }

  t.end();
});

test('warmupDownstreamServices probes all configured downstream services including settlement-engine', async (t) => {
  const { getDownstreamServices, warmupDownstreamServices } = await import('./index.js');

  const mockEnv: any = {
    FX_ENGINE_URL: 'http://fx-engine:3002',
    INDEXER_URL: 'http://indexer:3003',
    SETTLEMENT_ENGINE_URL: 'http://settlement-engine:3001',
  };

  const configured = getDownstreamServices(mockEnv);
  t.equal(configured.length, 3, 'three downstream services configured for warmup');
  t.ok(
    configured.some((s) => s.name === 'settlement-engine' && s.healthUrl === 'http://settlement-engine:3001/api/health'),
    'settlement-engine is included in getDownstreamServices',
  );
  t.ok(
    configured.some((s) => s.name === 'fx-engine' && s.healthUrl === 'http://fx-engine:3002/api/health'),
    'fx-engine is included in getDownstreamServices',
  );
  t.ok(
    configured.some((s) => s.name === 'indexer' && s.healthUrl === 'http://indexer:3003/api/health'),
    'indexer is included in getDownstreamServices',
  );

  const capturedUrls: string[] = [];
  const capturedTraceIds: string[] = [];
  const infoLogs: any[] = [];
  const warnLogs: any[] = [];

  const mockLogger: any = {
    info: (obj: any, msg: string) => infoLogs.push({ obj, msg }),
    warn: (obj: any, msg: string) => warnLogs.push({ obj, msg }),
  };

  // One service fails, others succeed — verify failures remain non-fatal and logged
  const mockFetch: any = async (url: string, init?: RequestInit) => {
    capturedUrls.push(url);
    const traceId = (init?.headers as any)?.['x-trace-id'];
    if (traceId) capturedTraceIds.push(traceId);

    if (url.includes('settlement-engine')) {
      throw new Error('Connection refused to settlement engine');
    }
    return new Response('ok', { status: 200 });
  };

  // Must not throw even when settlement-engine throws
  await warmupDownstreamServices(mockEnv, mockLogger, mockFetch);

  t.equal(capturedUrls.length, 3, 'all 3 services were probed');
  t.ok(capturedUrls.includes('http://settlement-engine:3001/api/health'), 'settlement-engine health URL was probed');
  t.ok(capturedUrls.includes('http://fx-engine:3002/api/health'), 'fx-engine health URL was probed');
  t.ok(capturedUrls.includes('http://indexer:3003/api/health'), 'indexer health URL was probed');

  t.equal(capturedTraceIds.length, 3, 'each probe carried an x-trace-id header');
  for (const tid of capturedTraceIds) {
    t.ok(/^[0-9a-f-]{36}$/.test(tid), 'trace-id is a valid UUID format');
  }

  t.equal(infoLogs.length, 2, 'two successful services logged info');
  t.equal(warnLogs.length, 1, 'failing settlement-engine warmup logged warn');
  t.equal(warnLogs[0].obj.targetService, 'settlement-engine', 'warn log identifies settlement-engine failure');
  t.match(warnLogs[0].msg, /Warmup failed/, 'warn log indicates warmup failure was non-fatal');

  t.end();
});
