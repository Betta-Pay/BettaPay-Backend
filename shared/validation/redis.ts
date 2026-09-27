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
}

const sharedRedisClients = new Map<string, Redis>();

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

  if (!sharedRedisClients.has(url)) {
    const client = createRedisClient(url, log, {
      ...clientOpts,
      maxRetriesPerRequest: clientOpts.maxRetriesPerRequest ?? null,
      shared: false,
    });
    sharedRedisClients.set(url, client);
  }
  return sharedRedisClients.get(url)!;
}

export async function clearSharedRedisClients(): Promise<void> {
  for (const client of sharedRedisClients.values()) {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
  sharedRedisClients.clear();
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
    ...rest
  } = clientOpts;

  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    ...rest,
    retryStrategy: (attempt: number) => {
      const delay = Math.min(Math.pow(2, attempt) * 100, maxDelayMs);
      log?.warn({ attempt, delayMs: delay }, 'Redis connection retry');
      return delay;
    },
  });

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
