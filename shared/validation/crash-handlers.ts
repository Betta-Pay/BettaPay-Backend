import type { MinimalLogger } from './redis.js';

let installed = false;

/**
 * Last-resort guards for a service's entrypoint: without these, an uncaught
 * exception or unhandled rejection anywhere in the process (e.g. a poll loop
 * or background worker with no local try/catch) crashes silently with only a
 * raw Node stack trace on stderr, never reaching structured logs/alerting.
 *
 * Registration is idempotent (#862) — calling installCrashHandlers more than
 * once within the same process will not register duplicate handlers.
 */
export function installCrashHandlers(logger: MinimalLogger): void {
  if (installed) {
    return;
  }
  installed = true;

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection — exiting');
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
