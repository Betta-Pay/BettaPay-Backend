/** Public health-builder entrypoint for services. */
export {
  buildHealthResponse,
  buildFxEngineHealthResponse,
  buildSettlementEngineHealthResponse,
  buildIndexerHealthResponse,
  aggregateAllHealth,
} from './health.js';
export type { AggregateHealthOptions, ServiceHealthTarget } from './health.js';
