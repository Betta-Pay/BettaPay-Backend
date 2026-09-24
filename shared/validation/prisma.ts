export type PrismaLogLevel = 'query' | 'info' | 'warn' | 'error';

const ALL_PRISMA_LOG_LEVELS: readonly PrismaLogLevel[] = ['query', 'info', 'warn', 'error'];

let _rotateUrl: string | undefined;
let _hasRotated = false;

export function setRotationUrl(url: string | undefined): void {
  _rotateUrl = url;
  _hasRotated = false;
}

export function resetRotation(): void {
  _rotateUrl = undefined;
  _hasRotated = false;
}

export function hasRotated(): boolean {
  return _hasRotated;
}

export function getActiveConnectionUrl(primaryUrl: string): string {
  return _hasRotated && _rotateUrl !== undefined ? _rotateUrl : primaryUrl;
}

function isPrismaLogLevel(value: string): value is PrismaLogLevel {
  return (ALL_PRISMA_LOG_LEVELS as readonly string[]).includes(value);
}

// PRISMA_LOG_LEVELS is a comma-separated override, e.g. "error,warn". Falls
// back to the NODE_ENV default when unset, empty, or containing no valid level.
function parsePrismaLogLevelsOverride(raw: string | undefined): PrismaLogLevel[] | undefined {
  if (!raw) return undefined;
  const levels = raw
    .split(',')
    .map((level) => level.trim().toLowerCase())
    .filter(isPrismaLogLevel);
  return levels.length > 0 ? levels : undefined;
}

function defaultPrismaLogLevelsForEnv(nodeEnv: string | undefined): PrismaLogLevel[] {
  if (nodeEnv === 'production') return ['error', 'warn'];
  if (nodeEnv === 'test') return ['error'];
  return ['query', 'info', 'warn', 'error'];
}

export interface PrismaQueryEvent {
  query: string;
  duration: number;
}

export interface PrismaConnectable {
  $connect: () => Promise<void>;
}

export interface PrismaQueryable {
  $on: (event: 'query', callback: (event: PrismaQueryEvent) => void) => void;
}

export interface PrismaLogger {
  debug: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldEnablePrismaQueryLogging(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development';
}

export function getPrismaLogLevels(): PrismaLogLevel[] {
  const override = parsePrismaLogLevelsOverride(process.env.PRISMA_LOG_LEVELS);
  const levels = override ?? defaultPrismaLogLevelsForEnv(process.env.NODE_ENV);
  const source = override ? 'PRISMA_LOG_LEVELS override' : `NODE_ENV=${process.env.NODE_ENV ?? 'development'} default`;
  console.log(`[Prisma] log levels: ${levels.join(', ')} (${source})`);
  return levels;
}

export function setupPrismaQueryLogging(prisma: PrismaQueryable, logger: PrismaLogger): void {
  if (!shouldEnablePrismaQueryLogging()) return;

  prisma.$on('query', (event) => {
    logger.debug({ query: event.query, duration: event.duration }, 'Prisma query');
  });
}

export interface ConnectWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function connectWithRetry(
  prisma: PrismaConnectable,
  logger: PrismaLogger,
  options: ConnectWithRetryOptions = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await prisma.$connect();
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.warn(
          { attempt: attempt + 1, maxRetries, delayMs: delay, err },
          'Database connection failed, retrying'
        );
        await sleep(delay);
      }
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${message}`);
}

/**
 * Build a Prisma-compatible connection URL with pool and timeout parameters.
 *
 * Appends `connection_limit` and `pool_timeout` as query parameters to the
 * raw DATABASE_URL. These tell Prisma's internal query engine how many
 * concurrent connections to allow and how long to wait before timing out a
 * pooled connection request. Without explicit values Prisma defaults to an
 * unbounded pool — a recipe for connection exhaustion under load.
 *
 * The function safely detects whether the URL already carries a query string
 * (i.e. contains "?") and uses "&" instead of "?" to avoid clobbering any
 * pre-existing parameters such as sslmode, schema, or application_name.
 *
 * @param rawUrl   - The base DATABASE_URL (e.g. postgresql://user:pass@host:5432/db).
 * @param poolSize - Max connections in the Prisma pool (default: 10).
 * @param timeout  - Max seconds to wait for a connection from the pool (default: 10).
 */
export function buildPrismaConnectionUrl(
  rawUrl: string,
  poolSize: number = 10,
  timeout: number = 10,
): string {
  const sep = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${sep}connection_limit=${poolSize}&pool_timeout=${timeout}`;
}

export interface ConnectWithRotationOptions extends ConnectWithRetryOptions {
  rotationUrl?: string;
  logger?: PrismaLogger;
}

export async function connectWithRetryWithRotation(
  prisma: PrismaConnectable,
  logger: PrismaLogger,
  options: ConnectWithRotationOptions = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const rotationUrl = options.rotationUrl;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await prisma.$connect();
      return;
    } catch (err) {
      lastError = err;
      const isAuthError = (err as { code?: string })?.code === '28P01';

      if (isAuthError && rotationUrl && !_hasRotated) {
        _hasRotated = true;
        _rotateUrl = rotationUrl;
        const rotationLogger = options.logger ?? logger;
        rotationLogger.warn(
          { attempt: attempt + 1 },
          'Database credential rotation: switching to rotation URL due to authentication error (28P01)'
        );
      }

      if (attempt < maxRetries - 1) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.warn(
          { attempt: attempt + 1, maxRetries, delayMs: delay, err },
          'Database connection failed, retrying'
        );
        await sleep(delay);
      }
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${message}`);
}

import { readReplicas } from "@prisma/extension-read-replicas";

interface PrismaClientLike {
  $extends: (extension: unknown) => any;
}

const REPLICA_WARNING_EMITTED = Symbol("replicaWarningEmitted");

export function applyReadReplicas<T extends PrismaClientLike>(
  client: T,
  replicaUrl?: string | null,
  logger?: { warn: (obj: object, msg?: string) => void },
): T {
  if (!replicaUrl) {
    if (logger && !(REPLICA_WARNING_EMITTED in client)) {
      logger.warn(
        { hint: "Set DATABASE_READ_REPLICA_URL to offload read queries to a replica" },
        "No read-replica configured — all queries use the primary database",
      );
      Object.defineProperty(client, REPLICA_WARNING_EMITTED, { value: true });
    }
    return client;
  }

  return client.$extends(
    readReplicas({
      replicas: [{ url: replicaUrl }],
    }),
  ) as unknown as T;
}
