import crypto from 'crypto';
import http, { type Server } from 'http';

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/**
 * Resolves the port the metrics server binds to (#835).
 * When a validated metricsPort is provided, that value is used.
 * Otherwise defaults to `appPort + 1000` (e.g. 4000 for a service running on 3000)
 * so metrics stay separated from the application port without requiring per-service config.
 */
export function resolveMetricsPort(appPort: number, metricsPort?: number): number {
  if (typeof metricsPort === 'number') {
    return metricsPort;
  }
  return appPort + 1000;
}

export interface StartMetricsServerOptions {
  /** The service's application port, used to derive the default metrics port. */
  appPort: number;
  /**
   * Validated metrics port from environment/config (#835).
   * If omitted, defaults to `appPort + 1000`.
   */
  metricsPort?: number;
  /** Content-Type header for the metrics response (e.g. prom-client's `register.contentType`). */
  contentType: string;
  /** Returns the current metrics payload (e.g. prom-client's `register.metrics()`). */
  getMetrics: () => Promise<string> | string;
  log: MinimalLogger;
  /**
   * Optional Bearer token for scrape authentication (#528).
   * When set, requests must include `Authorization: Bearer <token>`.
   * If omitted, metrics are served unauthenticated (network isolation required).
   */
  scrapeToken?: string;
  /**
   * Interface to bind (#1074). Defaults to `0.0.0.0` when `scrapeToken` is set
   * and to loopback (`127.0.0.1`) when it is not, so unauthenticated metrics
   * are never exposed beyond the host unless explicitly requested.
   */
  host?: string;
}

/**
 * Resolves the interface the metrics server binds to (#1074).
 * An explicit host always wins; otherwise authenticated servers listen on all
 * interfaces and unauthenticated ones stay on loopback.
 */
export function resolveMetricsHost(scrapeToken?: string, host?: string): string {
  if (host) return host;
  return scrapeToken ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Constant-time Bearer token check (#1074). Both sides are hashed first so the
 * comparison runs over equal-length buffers and leaks neither the token's
 * contents nor its length through timing.
 */
function isAuthorized(authHeader: string | undefined, scrapeToken: string): boolean {
  const expected = crypto.createHash('sha256').update(`Bearer ${scrapeToken}`).digest();
  const actual = crypto.createHash('sha256').update(authHeader ?? '').digest();
  return crypto.timingSafeEqual(actual, expected) && authHeader !== undefined;
}

/** Returns the request pathname with any query string or fragment stripped. */
function getPathname(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * Starts a minimal, dedicated HTTP server that serves only `GET /metrics`.
 * 
 * Security (#528):
 *  - When `scrapeToken` is provided, requests must include
 *    `Authorization: Bearer <token>`. Unauthorized requests receive 401.
 *  - When `scrapeToken` is omitted, metrics are served unauthenticated and
 *    the server binds to 127.0.0.1 by default (#1074). Pass `host` to
 *    override, in which case network isolation is the caller's responsibility.
 *  - Token comparison is constant-time (#1074).
 *  - `/metrics?...` query strings are ignored when routing (#1074).
 *  - Listen errors (e.g. EADDRINUSE) are logged rather than crashing (#1074).
 * 
 * Runs on its own port (see resolveMetricsPort) so this data never shares
 * the application's listener, and has no rate limiting or request logging
 * to keep scrape overhead minimal.
 */
export function startMetricsServer(options: StartMetricsServerOptions): Server {
  const port = resolveMetricsPort(options.appPort, options.metricsPort);
  const { scrapeToken } = options;
  const host = resolveMetricsHost(scrapeToken, options.host);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || getPathname(req.url) !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Bearer token authentication (#528)
    if (scrapeToken) {
      if (!isAuthorized(req.headers.authorization, scrapeToken)) {
        res.writeHead(401, { 
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Bearer realm="metrics"'
        });
        res.end('Unauthorized');
        return;
      }
    }

    Promise.resolve(options.getMetrics())
      .then((body) => {
        res.writeHead(200, { 'Content-Type': options.contentType });
        res.end(body);
      })
      .catch((error: unknown) => {
        options.log.error({ error }, 'Failed to collect metrics');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to collect metrics');
      });
  });

  // Without this listener a bind failure (EADDRINUSE, EACCES) is an unhandled
  // 'error' event and takes down the whole service process.
  server.on('error', (error: NodeJS.ErrnoException) => {
    options.log.error(
      { error, code: error.code, port, host },
      `Metrics server error on ${host}:${port}`,
    );
  });

  server.listen(port, host, () => {
    const authStatus = scrapeToken ? '(auth required)' : '(unauthenticated - ensure network isolation)';
    options.log.info({ port, host, authenticated: !!scrapeToken }, `Metrics server listening on ${host}:${port}/metrics ${authStatus}`);
  });

  return server;
}
