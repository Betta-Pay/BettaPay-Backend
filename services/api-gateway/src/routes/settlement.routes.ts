/** Canonical settlement route ownership. This explicit boundary documents
 * which routes belong to the settlement client/engine and supports the
 * incremental extraction of their handlers from the gateway bootstrap. */
export const SETTLEMENT_ROUTE_MODULES = [
  'settlements',
  'settlement-status',
  'settlement-reconciliation',
] as const;

export type SettlementRouteModule = (typeof SETTLEMENT_ROUTE_MODULES)[number];
