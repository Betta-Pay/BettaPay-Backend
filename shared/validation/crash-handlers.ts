import type { MinimalLogger } from './redis.js';

/**
 * Logger accepted by installCrashHandlers. Fastify/Pino loggers satisfy this;
 * when `fatal` is available it is preferred over `error` so crash lines land
 * at the highest severity.
 */
export interface CrashHandlerLogger extends MinimalLogger {
  fatal?: (obj: object, msg?: string) => void;
}

let installed = false;

/**
 * Last-resort guards for a service's entrypoint: without these, an uncaught
 * exception or unhandled rejection anywhere in the process (e.g. a poll loop
 * or background worker with no local try/catch) crashes silently with only a
 * raw Node stack trace on stderr, never reaching structured logs/alerting.
 *
 * Registration is idempotent (#862) — calling installCrashHandlers more than
 * once within the same process will not register duplicate handlers.
 *
 * This is the single implementation; `logger.ts` re-exports it (#1080).
 */
export function installCrashHandlers(logger: CrashHandlerLogger): void {
  if (installed) {
    return;
  }
  installed = true;

  const logFatal = (obj: object, msg: string) =>
    logger.fatal ? logger.fatal(obj, msg) : logger.error(obj, msg);

  process.on('uncaughtException', (err) => {
    logFatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logFatal({ err: reason }, 'Unhandled rejection — exiting');
    process.exit(1);
  });
}

/**
 * Resets the crash handler registration flag.
 * For use in unit test teardown.
 */
export function _resetCrashHandlersForTesting(): void {
  installed = false;
}
