/** Canonical gateway route ownership. Handlers are registered from index.ts
 * while this module provides one auditable boundary for gateway-only routes.
 * Keeping the list here prevents new downstream routes from being added to
 * the gateway accidentally and is used by route inventory tooling. */
export const GATEWAY_ROUTE_MODULES = [
  'auth',
  'merchants',
  'payments',
  'deployments',
  'fx-proxy',
  'supported-assets',
] as const;

export type GatewayRouteModule = (typeof GATEWAY_ROUTE_MODULES)[number];
