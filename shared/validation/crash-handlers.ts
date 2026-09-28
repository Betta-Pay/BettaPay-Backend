import type { MinimalLogger } from './redis.js';

/**
 * Last-resort guards for a service's entrypoint: without these, an uncaught
 * exception or unhandled rejection anywhere in the process (e.g. a poll loop
 * or background worker with no local try/catch) crashes silently with only a
 * raw Node stack trace on stderr, never reaching structured logs/alerting.
 */
export function installCrashHandlers(logger: MinimalLogger): void {
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection — exiting');
    process.exit(1);
  });
}
