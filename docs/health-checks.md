# Health Checks

BettaPay exposes comprehensive health endpoints on every backend service. Each endpoint reports dependency connectivity, latency, service version, and an overall status that operators and load balancers can use for routing decisions.

## Endpoints

| Service | Endpoint | Purpose |
|---------|----------|---------|
| api-gateway | `GET /api/health` | Gateway DB + upstream service probes |
| api-gateway | `GET /api/health/all` | Aggregated health for all services |
| fx-engine | `GET /api/health` | Redis + external rates API |
| settlement-engine | `GET /api/health` | PostgreSQL + Redis + BullMQ settlement queue |
| indexer | `GET /api/health` | PostgreSQL + Redis + BullMQ webhooks + Stellar RPC |

Health endpoints are unauthenticated so orchestrators and uptime monitors can call them without credentials.

## Response Format

All services return the shared `HealthResponse` shape defined in `@bettapay/shared-types`:

```json
{
  "status": "healthy",
  "service": "api-gateway",
  "version": "0.1.0",
  "uptime": 3600,
  "lastDependencyCheck": "2026-07-20T14:00:00.000Z",
  "dependencies": [
    {
      "name": "postgresql",
      "status": "connected",
      "latencyMs": 12
    }
  ],
  "upstream": [
    {
      "name": "fx-engine",
      "status": "connected",
      "latencyMs": 45,
      "details": {
        "status": "healthy",
        "version": "0.1.0",
        "service": "fx-engine"
      }
    }
  ]
}
```

### Status Values

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `healthy` | All critical dependencies are connected |
| `status` | `degraded` | Non-critical dependency failed, or indexer lag exceeds threshold |
| `status` | `unhealthy` | At least one critical dependency is disconnected |
| `dependencies[].status` | `connected` / `disconnected` | Result of the individual probe |

HTTP status codes:

- `200` — `healthy` or `degraded`
- `503` — `unhealthy`

## Aggregated Gateway Health

`GET /api/health/all` on the api-gateway collects health from all downstream services using `Promise.allSettled`. Each downstream call has a **5 second timeout**. One failing service does not block the response; the gateway returns the best available snapshot and marks unreachable services as `unhealthy`.

```json
{
  "status": "degraded",
  "service": "api-gateway",
  "version": "0.1.0",
  "uptime": 3600,
  "lastDependencyCheck": "2026-07-20T14:00:00.000Z",
  "dependencies": [
    { "name": "postgresql", "status": "connected", "latencyMs": 10 }
  ],
  "upstream": [
    { "name": "fx-engine", "status": "connected", "latencyMs": 40 }
  ],
  "services": {
    "api-gateway": { "status": "healthy", "service": "api-gateway", "version": "0.1.0", "uptime": 3600 },
    "fx-engine": { "status": "healthy", "service": "fx-engine", "version": "0.1.0", "uptime": 3500 },
    "settlement-engine": { "status": "degraded", "service": "settlement-engine", "version": "0.1.0" },
    "indexer": { "status": "unhealthy", "error": "connection refused" }
  }
}
```

## Per-Service Dependencies

### api-gateway

| Dependency | Type | Critical |
|------------|------|----------|
| `postgresql` | Database ping (`SELECT 1`) | Yes |
| `fx-engine` | Upstream `/api/health` | No (upstream probe) |
| `settlement-engine` | Upstream `/api/health` | No |
| `indexer` | Upstream `/api/health` | No |

### fx-engine

| Dependency | Type | Critical |
|------------|------|----------|
| `redis` | `PING` | Yes |
| `rates-api` | HTTP GET to `RATES_API_URL` | No |

### settlement-engine

| Dependency | Type | Critical |
|------------|------|----------|
| `postgresql` | Database ping | Yes |
| `redis` | `PING` | Yes |
| `bullmq-settlement` | `getJobCounts()` on settlement queue | Yes |

### indexer

| Dependency | Type | Critical |
|------------|------|----------|
| `postgresql` | Database ping | Yes |
| `redis` | `PING` | Yes |
| `bullmq-webhooks` | `getJobCounts()` on webhook queue | Yes |
| `stellar-rpc` | `getLatestLedger()` via Soroban RPC | Yes |

When indexer lag exceeds `INDEXER_LAG_WARN_THRESHOLD`, overall status becomes `degraded` even if all probes succeed.

## Probe Timeouts

| Probe | Timeout |
|-------|---------|
| PostgreSQL, Redis, BullMQ | 3 seconds |
| Upstream service health (gateway) | 5 seconds |
| Aggregated `/api/health/all` downstream fetch | 5 seconds per service |

## Version Field

Each response includes `version` from the service's own `package.json` (for example `0.1.0` for api-gateway).

## Usage Examples

```bash
# Gateway health with upstream probes
curl -s http://localhost:3000/api/health | jq

# Full platform snapshot
curl -s http://localhost:3000/api/health/all | jq

# Individual service
curl -s http://localhost:3002/api/health | jq
curl -s http://localhost:3001/api/health | jq
curl -s http://localhost:3003/api/health | jq
```

## Implementation Notes

- Shared types live in `@bettapay/shared-types` (`HealthResponse`, `DependencyHealth`, `AggregatedHealthResponse`).
- Probe helpers live in `@bettapay/validation/health`.
- Gateway route registration is in `services/api-gateway/src/health.ts`.
- Aggregated checks use `Promise.allSettled` so partial failures still produce a useful response.
