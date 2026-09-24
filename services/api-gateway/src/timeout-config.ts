export const GATEWAY_TIMEOUT_CONFIG = {
  requestTimeoutMs: 30_000,
  connectionTimeoutMs: 31_000,
  responseHeader: 'x-request-timeout-ms',
} as const;

export const REQUEST_TIMEOUT_MS = GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs;
export const CONNECTION_TIMEOUT_MS = GATEWAY_TIMEOUT_CONFIG.connectionTimeoutMs;
