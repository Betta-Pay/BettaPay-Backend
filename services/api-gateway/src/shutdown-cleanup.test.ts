import test from 'tape';
import {
  shutdown,
  setSharedPgPool,
  getSharedPgPool,
  setSharedRedis,
  getSharedRedis,
  setMainApp,
  resetShutdownStateForTests,
} from './index.js';

test('shutdown cleans up sharedRedis, pg.Pool, and shared redis clients', async (t) => {
  resetShutdownStateForTests();

  let poolEnded = false;
  const mockPool = {
    end: async () => {
      poolEnded = true;
    },
  };

  let redisQuitCalled = false;
  let redisDisconnectCalled = false;
  const mockRedis = {
    quit: async () => {
      redisQuitCalled = true;
    },
    disconnect: () => {
      redisDisconnectCalled = true;
    },
  };

  let appClosed = false;
  const mockApp = {
    close: async () => {
      appClosed = true;
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  setSharedPgPool(mockPool as any);
  setSharedRedis(mockRedis as any);
  setMainApp(mockApp as any);

  // Invoke shutdown with exitProcess = false so process.exit is not called
  await shutdown('SIGTERM', false);

  t.equal(poolEnded, true, 'sharedPgPool.end() was invoked during shutdown');
  t.equal(getSharedPgPool(), null, 'sharedPgPool was reset to null');
  t.equal(redisQuitCalled, true, 'sharedRedis.quit() was invoked during shutdown');
  t.equal(getSharedRedis(), null, 'sharedRedis was reset to null');
  t.equal(appClosed, true, 'app.close() was invoked during shutdown');

  // Clean up
  resetShutdownStateForTests();
  setSharedPgPool(null);
  setSharedRedis(null);
  setMainApp(null);

  t.end();
});

test('shutdown handles pool.end() and redis.quit() failures gracefully (non-fatal)', async (t) => {
  resetShutdownStateForTests();

  let poolEnded = false;
  const mockPool = {
    end: async () => {
      poolEnded = true;
      throw new Error('Pool already closing');
    },
  };

  let redisQuitCalled = false;
  let redisDisconnectCalled = false;
  const mockRedis = {
    quit: async () => {
      redisQuitCalled = true;
      throw new Error('Connection closed');
    },
    disconnect: () => {
      redisDisconnectCalled = true;
    },
  };

  const warnLogs: any[] = [];
  const mockApp = {
    close: async () => {},
    log: {
      info: () => {},
      warn: (obj: any, msg: string) => warnLogs.push({ obj, msg }),
      error: () => {},
    },
  };

  setSharedPgPool(mockPool as any);
  setSharedRedis(mockRedis as any);
  setMainApp(mockApp as any);

  // Invoke shutdown — must not crash even if pool.end() or redis.quit() throws
  await shutdown('SIGINT', false);

  t.equal(poolEnded, true, 'pool.end() was called despite throwing');
  t.equal(redisQuitCalled, true, 'redis.quit() was called despite throwing');
  t.equal(redisDisconnectCalled, true, 'redis.disconnect() called as fallback when quit fails');
  t.equal(getSharedPgPool(), null, 'pool reference was cleared');
  t.equal(getSharedRedis(), null, 'redis reference was cleared');

  // Clean up
  resetShutdownStateForTests();
  setSharedPgPool(null);
  setSharedRedis(null);
  setMainApp(null);

  t.end();
});
