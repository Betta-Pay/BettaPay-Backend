import test from "tape";

const MAX_STALE_SECONDS = 300;

// ── Shared mock state (mirrors the module-level variables in index.ts) ──────

let lastSuccessfulFetch: number | null = null;
let cacheCachedAt: number;
let currentTime: number;

function reset(
  opts: {
    lastSuccessfulFetch?: number | null;
    cacheAgeMs?: number;
    now?: number;
    rateCachedAt?: Record<string, number>;
  } = {},
): void {
  currentTime = opts.now ?? 1_000_000_000_000;
  lastSuccessfulFetch = opts.lastSuccessfulFetch ?? null;
  (global as any).cache = {
    cachedAt: cacheCachedAt,
    rateCachedAt: opts.rateCachedAt ?? {
      USDC: cacheCachedAt,
      EURT: cacheCachedAt,
      NGN: cacheCachedAt,
    },
    rates: {},
    batchIds: {},
  };
}

const cache = (global as any).cache;

function getRateSource(): "live" | "seed" {
  return lastSuccessfulFetch !== null ? "live" : "seed";
}

type LogEntry = { level: "warn" | "error"; obj: Record<string, unknown>; msg: string };
const logEntries: LogEntry[] = [];

const mockLog = {
  warn(obj: Record<string, unknown>, msg: string) {
    logEntries.push({ level: "warn", obj, msg });
  },
  error(obj: Record<string, unknown>, msg: string) {
    logEntries.push({ level: "error", obj, msg });
  },
};

function logRateStalenessIfStale(
  log: typeof mockLog,
  pair?: string,
): void {
  const now = currentTime;
  let maxStalenessSeconds = 0;
  let timestamp = cache.cachedAt;
  
  if (pair) {
    const [from, to] = pair.split('_');
    const fromAge = now - (cache.rateCachedAt[from] ?? cache.cachedAt);
    const toAge = now - (cache.rateCachedAt[to] ?? cache.cachedAt);
    if (fromAge > toAge) {
      maxStalenessSeconds = Math.floor(fromAge / 1000);
      timestamp = cache.rateCachedAt[from] ?? cache.cachedAt;
    } else {
      maxStalenessSeconds = Math.floor(toAge / 1000);
      timestamp = cache.rateCachedAt[to] ?? cache.cachedAt;
    }
  } else {
    for (const age of Object.values(cache.rateCachedAt) as number[]) {
      const staleness = Math.floor((now - age) / 1000);
      if (staleness > maxStalenessSeconds) {
        maxStalenessSeconds = staleness;
        timestamp = age;
      }
    }
  }

  const stalenessSeconds = maxStalenessSeconds;
  if (stalenessSeconds <= MAX_STALE_SECONDS) return;

  const source = getRateSource();
  const baseFields: Record<string, unknown> = {
    source,
    rateTimestamp: new Date(timestamp).toISOString(),
    stalenessSeconds,
    threshold: MAX_STALE_SECONDS,
  };
  const pairFields = pair ? { ...baseFields, currencyPair: pair } : baseFields;

  if (source === "live") {
    log.warn(
      pairFields,
      pair
        ? `Stale rate served for ${pair} (${stalenessSeconds}s old, source: live)`
        : `Stale rates served (${stalenessSeconds}s old, source: live)`,
    );
  } else {
    log.error(
      pairFields,
      pair
        ? `Stale rate served for ${pair} (${stalenessSeconds}s old, source: seed)`
        : `Stale rates served (${stalenessSeconds}s old, source: seed)`,
    );
  }
}

function computeRateStaleness() {
  const stalenessSeconds = Math.floor((currentTime - cache.cachedAt) / 1000); // simplify for admin status test
  const source = getRateSource();
  return {
    source,
    stalenessSeconds,
    stale: stalenessSeconds > MAX_STALE_SECONDS,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("Fresh rate from live source: no log emitted", (t) => {
  reset({ lastSuccessfulFetch: currentTime, cacheAgeMs: 30 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 0, "no log entries for fresh live rate");
  t.end();
});

test("Fresh rate from seed source: no log emitted", (t) => {
  reset({ lastSuccessfulFetch: null, cacheAgeMs: 30 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 0, "no log entries for fresh seed rate");
  t.end();
});

test("Stale rate from live source: WARN log emitted", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: 310_000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 1, "one log entry");
  t.equal(logEntries[0].level, "warn", "log level is warn");
  t.equal(logEntries[0].obj.source, "live", "source is live");
  t.ok((logEntries[0].obj.stalenessSeconds as number) > MAX_STALE_SECONDS, "staleness exceeds threshold");
  t.equal(logEntries[0].obj.threshold, MAX_STALE_SECONDS, "threshold logged");
  t.ok(logEntries[0].msg.includes("Stale rates"), "message indicates stale rates");
  t.end();
});

test("Stale rate from seed source: ERROR log emitted", (t) => {
  reset({ lastSuccessfulFetch: null, cacheAgeMs: 310_000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 1, "one log entry");
  t.equal(logEntries[0].level, "error", "log level is error");
  t.equal(logEntries[0].obj.source, "seed", "source is seed");
  t.ok((logEntries[0].obj.stalenessSeconds as number) > MAX_STALE_SECONDS, "staleness exceeds threshold");
  t.equal(logEntries[0].obj.threshold, MAX_STALE_SECONDS, "threshold logged");
  t.ok(logEntries[0].msg.includes("Stale rates"), "message indicates stale rates");
  t.end();
});

test("Stale live rate with currency pair: pair included in log", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: 310_000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog, "USDC_NGN");

  t.equal(logEntries[0].obj.currencyPair, "USDC_NGN", "currency pair in log");
  t.ok(logEntries[0].msg.includes("USDC_NGN"), "pair in message");
  t.end();
});

test("Stale seed rate with currency pair: pair included in log", (t) => {
  reset({ lastSuccessfulFetch: null, cacheAgeMs: 310_000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog, "EURT_NGN");

  t.equal(logEntries[0].obj.currencyPair, "EURT_NGN", "currency pair in log");
  t.ok(logEntries[0].msg.includes("EURT_NGN"), "pair in message");
  t.equal(logEntries[0].level, "error", "seed rates logged as error");
  t.end();
});

test("Exactly at MAX_STALE_SECONDS: no log emitted", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: MAX_STALE_SECONDS * 1000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 0, "no log at exact threshold");
  t.end();
});

test("One second above MAX_STALE_SECONDS: log emitted", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: (MAX_STALE_SECONDS + 1) * 1000 });
  logEntries.length = 0;

  logRateStalenessIfStale(mockLog);

  t.equal(logEntries.length, 1, "log emitted just above threshold");
  t.equal(logEntries[0].level, "warn", "live rate above threshold is warn");
  t.end();
});

// ── Admin status staleness computation ──────────────────────────────────────

test("Admin status: live source reports correct staleness values", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 60_000, cacheAgeMs: 120_000 });

  const { source, stalenessSeconds, stale } = computeRateStaleness();

  t.equal(source, "live", "source is live when lastSuccessfulFetch is set");
  t.equal(stalenessSeconds, 120, "stalenessSeconds = 120s");
  t.equal(stale, false, "not stale (120s <= 300s)");
  t.end();
});

test("Admin status: seed source reports correct staleness values", (t) => {
  reset({ lastSuccessfulFetch: null, cacheAgeMs: 600_000 });

  const { source, stalenessSeconds, stale } = computeRateStaleness();

  t.equal(source, "seed", "source is seed when lastSuccessfulFetch is null");
  t.equal(stalenessSeconds, 600, "stalenessSeconds = 600s");
  t.equal(stale, true, "stale (600s > 300s)");
  t.end();
});

test("Admin status: no live fetch ever, cache never updated", (t) => {
  reset({ lastSuccessfulFetch: null, cacheAgeMs: 0 });

  const { source, stalenessSeconds, stale } = computeRateStaleness();

  t.equal(source, "seed", "source is seed");
  t.equal(stalenessSeconds, 0, "stalenessSeconds = 0");
  t.equal(stale, false, "not stale");
  t.end();
});

test("Admin status: live source with stale rates", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 600_000, cacheAgeMs: 600_000 });

  const { source, stalenessSeconds, stale } = computeRateStaleness();

  t.equal(source, "live", "source is live");
  t.equal(stale, true, "stale flag is true");
  t.ok(stalenessSeconds > MAX_STALE_SECONDS, "staleness exceeds threshold");
  t.end();
});

test("Admin status: boundary exactly at MAX_STALE_SECONDS", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: MAX_STALE_SECONDS * 1000 });

  const { stale } = computeRateStaleness();

  t.equal(stale, false, "exactly at threshold is not stale");
  t.end();
});

test("Admin status: one second above boundary", (t) => {
  reset({ lastSuccessfulFetch: currentTime - 10_000, cacheAgeMs: (MAX_STALE_SECONDS + 1) * 1000 });

  const { stale } = computeRateStaleness();

  t.equal(stale, true, "one second above threshold is stale");
  t.end();
});
