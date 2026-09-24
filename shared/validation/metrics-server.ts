import http, { type Server } from 'http';

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/**
 * Resolves the port the metrics server binds to. Defaults to `appPort + 1000`
 * (e.g. 4000 for a service running on 3000) so metrics stay separated from
 * the application port without requiring per-service config.
 */
export function resolveMetricsPort(appPort: number): number {
  const raw = process.env.METRICS_PORT;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return appPort + 1000;
}

export interface StartMetricsServerOptions {
  /** The service's application port, used to derive the default metrics port. */
  appPort: number;
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
}

/**
 * Starts a minimal, dedicated HTTP server that serves only `GET /metrics`.
 * 
 * Security (#528):
 *  - When `scrapeToken` is provided, requests must include
 *    `Authorization: Bearer <token>`. Unauthorized requests receive 401.
 *  - When `scrapeToken` is omitted, metrics are served unauthenticated.
 *    **Network isolation is required** (e.g., bind to 127.0.0.1 or use
 *    firewall rules) to prevent metric leakage.
 * 
 * Runs on its own port (see resolveMetricsPort) so this data never shares
 * the application's listener, and has no rate limiting or request logging
 * to keep scrape overhead minimal.
 */
export function startMetricsServer(options: StartMetricsServerOptions): Server {
  const port = resolveMetricsPort(options.appPort);
  const { scrapeToken } = options;

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Bearer token authentication (#528)
    if (scrapeToken) {
      const authHeader = req.headers.authorization;
      const expectedAuth = `Bearer ${scrapeToken}`;
      
      if (authHeader !== expectedAuth) {
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

  server.listen(port, '0.0.0.0', () => {
    const authStatus = scrapeToken ? '(auth required)' : '(unauthenticated - ensure network isolation)';
    options.log.info({ port, authenticated: !!scrapeToken }, `Metrics server listening on :${port}/metrics ${authStatus}`);
  });

  return server;
}
