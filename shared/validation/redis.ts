import { Redis, type RedisOptions } from 'ioredis';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MinimalLogger {
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface RedisHealthState {
  connected: boolean;
  errors: number;
  lastError?: string;
  reconnects: number;
}

export interface CreateRedisClientOptions extends Omit<RedisOptions, 'retryStrategy'> {
  maxDelayMs?: number;
  url?: string;
  logger?: MinimalLogger;
  shared?: boolean;
  onConnect?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  onReconnect?: () => void;
  healthState?: RedisHealthState;
  redisFactory?: (url: string, options: RedisOptions) => Redis;
}

interface SharedRedisEntry {
  client: Redis;
  healthStates: Set<RedisHealthState>;
}

const sharedRedisClients = new Map<string, SharedRedisEntry>();

/** Default upper bound on how long clearSharedRedisClients waits for each quit(). */
export const SHARED_REDIS_QUIT_TIMEOUT_MS = 2_000;

// Fan lifecycle events out to every healthState registered against a shared
// client, so later callers are not silently left with a stale state object.
function attachSharedHealthListeners(client: Redis, healthStates: Set<RedisHealthState>): void {
  client.on('connect', () => {
    for (const state of healthStates) state.connected = true;
  });
  client.on('error', (err: Error) => {
    for (const state of healthStates) {
      state.errors++;
      state.lastError = err.message;
    }
  });
  client.on('close', () => {
    for (const state of healthStates) state.connected = false;
  });
  client.on('reconnecting', () => {
    for (const state of healthStates) state.reconnects++;
  });
}

export function getSharedRedisClient(
  urlOrOptions?: string | CreateRedisClientOptions,
  logger?: MinimalLogger,
  options?: CreateRedisClientOptions,
): Redis {
  let url: string;
  let clientOpts: CreateRedisClientOptions;
  let log: MinimalLogger | undefined;

  if (typeof urlOrOptions === 'string') {
    url = urlOrOptions;
    log = logger;
    clientOpts = options ?? {};
  } else {
    clientOpts = urlOrOptions ?? {};
    url = clientOpts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    log = logger ?? clientOpts.logger;
  }

  let entry = sharedRedisClients.get(url);
  if (!entry) {
    const { healthState: _healthState, ...restOpts } = clientOpts;
    const client = createRedisClient(url, log, {
      ...restOpts,
      maxRetriesPerRequest: clientOpts.maxRetriesPerRequest ?? null,
      shared: false,
    });
    entry = { client, healthStates: new Set() };
    attachSharedHealthListeners(client, entry.healthStates);
    sharedRedisClients.set(url, entry);
  } else if (clientOpts.healthState && !entry.healthStates.has(clientOpts.healthState)) {
    // Late subscriber: seed with the client's current connection status.
    clientOpts.healthState.connected = entry.client.status === 'ready';
  }

  if (clientOpts.healthState) {
    entry.healthStates.add(clientOpts.healthState);
  }
  return entry.client;
}

async function quitWithTimeout(client: Redis, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const quitting = client.quit();
    // A rejection arriving after the timeout won the race must not go unhandled.
    quitting.catch(() => {});
    const result = await Promise.race([quitting, timedOut]);
    if (result === 'timeout') client.disconnect();
  } catch {
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}

// Quits every shared client, falling back to disconnect() if quit() rejects or
// does not settle within timeoutMs (e.g. Redis unreachable), so shutdown cannot hang.
export async function clearSharedRedisClients(
  timeoutMs: number = SHARED_REDIS_QUIT_TIMEOUT_MS,
): Promise<void> {
  const entries = [...sharedRedisClients.values()];
  sharedRedisClients.clear();
  await Promise.all(entries.map(({ client }) => quitWithTimeout(client, timeoutMs)));
}

// #386 & #231 — exponential backoff and shared Redis connection management.
// Supports connection sharing, lifecycle hooks (connect, error, close, reconnect),
// and default maxRetriesPerRequest: null for BullMQ compatibility.
export function createRedisClient(
  urlOrOptions?: string | CreateRedisClientOptions,
  logger?: MinimalLogger,
  options?: CreateRedisClientOptions,
): Redis {
  let url: string;
  let clientOpts: CreateRedisClientOptions;
  let log: MinimalLogger | undefined;

  if (typeof urlOrOptions === 'string') {
    url = urlOrOptions;
    log = logger;
    clientOpts = options ?? {};
  } else {
    clientOpts = urlOrOptions ?? {};
    url = clientOpts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    log = logger ?? clientOpts.logger;
  }

  if (clientOpts.shared) {
    return getSharedRedisClient(url, log, clientOpts);
  }

  const {
    maxDelayMs = 5_000,
    onConnect,
    onError,
    onClose,
    onReconnect,
    healthState,
    logger: _ignoredLogger,
    url: _ignoredUrl,
    shared: _ignoredShared,
    redisFactory = (redisUrl: string, redisOptions: RedisOptions) => new Redis(redisUrl, redisOptions),
    ...rest
  } = clientOpts;

  const clientOptions: RedisOptions = {
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    ...rest,
    retryStrategy: (attempt: number) => {
      const delay = Math.min(Math.pow(2, attempt) * 100, maxDelayMs);
      log?.warn({ attempt, delayMs: delay }, 'Redis connection retry');
      return delay;
    },
  };
  const client = redisFactory(url, clientOptions);

  client.on('connect', () => {
    log?.info({ url }, 'Redis connection established');
    if (healthState) {
      healthState.connected = true;
    }
    onConnect?.();
  });

  client.on('error', (err: Error) => {
    log?.warn({ err: err.message, url }, 'Redis connection error');
    if (healthState) {
      healthState.errors++;
      healthState.lastError = err.message;
    }
    onError?.(err);
  });

  client.on('close', () => {
    log?.warn({ url }, 'Redis connection closed');
    if (healthState) {
      healthState.connected = false;
    }
    onClose?.();
  });

  client.on('reconnecting', () => {
    log?.info({ url }, 'Redis reconnecting');
    if (healthState) {
      healthState.reconnects++;
    }
    onReconnect?.();
  });

  return client;
}

export interface WaitForRedisOptions {
  maxRetries?: number;
  intervalMs?: number;
}

// #391 — block startup until Redis responds to PING or exhaust retries and throw.
export async function waitForRedis(
  redis: Redis,
  logger: MinimalLogger,
  options: WaitForRedisOptions = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? 10;
  const intervalMs = options.intervalMs ?? 1_000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await redis.ping();
      logger.info({ attempt: attempt + 1 }, 'Redis ready');
      return;
    } catch (err) {
      const remaining = maxRetries - attempt - 1;
      if (remaining > 0) {
        logger.warn(
          { attempt: attempt + 1, maxRetries, nextRetryMs: intervalMs, err: (err as Error).message },
          'Redis not ready, retrying',
        );
        await sleep(intervalMs);
      }
    }
  }

  throw new Error(`Redis not ready after ${maxRetries} attempts — aborting startup`);
}

export interface RedisMemoryMonitorOptions {
  intervalMs?: number;
  warnThresholdRatio?: number;
}

interface MemoryMonitorResult {
  stop: () => void;
}

// #387 — poll Redis INFO every intervalMs; log warn when usage exceeds threshold.
// Returns a handle with a stop() method to cancel the interval on shutdown.
export function startRedisMemoryMonitor(
  redis: Redis,
  logger: MinimalLogger,
  options: RedisMemoryMonitorOptions = {},
): MemoryMonitorResult {
  const intervalMs = options.intervalMs ?? 30_000;
  const warnThresholdRatio = options.warnThresholdRatio ?? 0.8;

  let lastEvictedKeys = 0;

  async function collect(): Promise<void> {
    try {
      const [memInfo, statsInfo] = await Promise.all([
        redis.info('memory'),
        redis.info('stats'),
      ]);

      const usedMemory = parseRedisInfoInt(memInfo, 'used_memory');
      const maxMemory = parseRedisInfoInt(memInfo, 'maxmemory');
      const evictedKeys = parseRedisInfoInt(statsInfo, 'evicted_keys');

      const evictedDelta = evictedKeys - lastEvictedKeys;
      lastEvictedKeys = evictedKeys;

      logger.info(
        {
          redis_memory_usage_bytes: usedMemory,
          redis_evicted_keys_total: evictedKeys,
          redis_evicted_keys_delta: evictedDelta,
          maxmemory: maxMemory,
        },
        'Redis memory stats',
      );

      if (maxMemory > 0 && usedMemory / maxMemory > warnThresholdRatio) {
        logger.warn(
          {
            redis_memory_usage_bytes: usedMemory,
            maxmemory: maxMemory,
            utilizationPct: ((usedMemory / maxMemory) * 100).toFixed(1),
            threshold: `${warnThresholdRatio * 100}%`,
          },
          'Redis memory usage above warning threshold',
        );
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Failed to collect Redis memory stats');
    }
  }

  const handle = setInterval(collect, intervalMs);
  if (typeof (handle as any).unref === 'function') (handle as any).unref();

  return {
    stop: () => clearInterval(handle),
  };
}

function parseRedisInfoInt(info: string, key: string): number {
  const match = info.match(new RegExp(`^${key}:(\\d+)`, 'm'));
  return match ? parseInt(match[1], 10) : 0;
}
