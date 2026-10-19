# Production Deploy Checklist (Render)

This guide covers hardening and deploying BettaPay Backend from `render.yaml` and the GitHub Actions deployment workflow. Review every item before the first production Blueprint sync.

## GitHub Actions deploy requirements

The workflow in `.github/workflows/deploy.yml` deploys to the production Render environment. It is intentionally real and gated by the `production` GitHub environment.

Required repository secrets:

- `RENDER_API_KEY` — API token used to call the Render Deploy API.
- `RENDER_SERVICE_ID` — the Render service ID that receives the production deploy.

Required environment protections:

- Set the GitHub environment to `production` and require at least one reviewer approval before a deployment runs.
- Keep `DATABASE_URL`, `INTER_SERVICE_SECRET`, and other runtime secrets in the Render dashboard or a secure secret manager rather than in the repo.
- Treat any deployment secret as sensitive; do not log or print values in workflow output.

Manual deploys should only target the production service after the branch and environment checks are green and the release notes are reviewed.

Related docs:

- [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- [Render Scaling](https://render.com/docs/scaling)

Each service exposes `GET /api/health` for readiness probes (gateway also has aggregated health when available).

---

## Pre-deploy: `render.yaml` review

### 1. CORS — `ALLOWED_ORIGINS` (required)

- [ ] **Do not** set `ALLOWED_ORIGINS` to `*`.
- [ ] Wildcard CORS is invalid with `credentials: true` (Fetch spec) and is rejected by production validation in `shared/validation/cors.ts`.
- [ ] In the Render Dashboard, set `ALLOWED_ORIGINS` on **api-gateway** to an explicit HTTPS frontend URL (comma-separated for multiple origins).

```text
ALLOWED_ORIGINS=https://betta-pay-frontend.vercel.app
# or
ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
```

`sync: false` means Blueprint will not overwrite the value you set in the dashboard.

### 2. Inter-service auth — `INTER_SERVICE_SECRET` (required)

- [ ] Generate one strong secret (≥ 16 characters; prefer 32+).
- [ ] Set the **same** value on **all four** services: `api-gateway`, `fx-engine`, `settlement-engine`, `indexer`.
- [ ] Do **not** rely on `generateValue` on the gateway + `fromService` on private services for first-time deploy — that creates a chicken-and-egg race during Blueprint sync.

```bash
# Example local generation (do not commit the result)
openssl rand -hex 32
```

### 3. Health checks

- [ ] Confirm each service exposes `GET /api/health`.
- [ ] `healthCheckPath: /api/health` is set on all four services in `render.yaml`.
- [ ] Note: Render documents `healthCheckPath` as **web services only**. The public gateway uses it for zero-downtime deploys. Private services still expose `/api/health` for internal monitoring; Render may fall back to TCP checks for `pserv`.

Optional post-deploy probe (gateway public URL):

```bash
curl -sS https://<api-gateway-host>/api/health
curl -sS https://<api-gateway-host>/api/health/all
```

Expect `200` for `healthy` / `degraded`, `503` for `unhealthy`.

### 4. Plans and upgrade path

| Resource | Blueprint default | Production upgrade path |
|----------|-------------------|-------------------------|
| api-gateway | `starter` | starter → standard → pro |
| fx-engine | `starter` | starter → standard → pro |
| settlement-engine | `starter` | starter → standard → pro |
| indexer | `starter` | starter → standard → pro |
| Postgres (`bettapay-db`) | `free` | free → basic → pro |
| Redis (`bettapay-redis`) | `free` | free → starter → standard / pro |

- [ ] Confirm plan sizes match expected traffic and Redis/DB connection limits.
- [ ] Upgrade Postgres/Redis off `free` before production load.

### 5. High availability (`numInstances` / `scaling`)

- [ ] **api-gateway**: autoscaling with `minInstances: 2` (HA floor). If Pro autoscaling is unavailable, remove `scaling` and set `numInstances: 2`.
- [ ] **fx-engine / settlement-engine**: `numInstances: 2` + autoscaling block (Pro+). For cost-sensitive staging, set `numInstances: 1` and remove `scaling`.
- [ ] **indexer**: keep `numInstances: 1` until multi-instance cursor coordination exists. Documented HA path is `numInstances: 2` only after that work lands.
- [ ] Remember: when `scaling` is present, Render ignores `numInstances` for that service.

### 6. Autoscaling thresholds

Configured targets (Pro workspace required):

| Service | min | max | CPU | Memory |
|---------|-----|-----|-----|--------|
| api-gateway | 2 | 5 | 60% | 60% |
| fx-engine | 2 | 4 | 70% | 70% |
| settlement-engine | 2 | 4 | 70% | 70% |
| indexer | — | — | commented out | commented out |

- [ ] Confirm the workspace plan supports autoscaling (Pro+).
- [ ] If not on Pro, delete/comment `scaling` blocks and use manual `numInstances` instead.

### 7. Private services (`pserv`) networking

- [ ] `fx-engine`, `settlement-engine`, and `indexer` remain `type: pserv` (no public URL).
- [ ] Internal URLs (`http://fx-engine:3002`, etc.) are only reachable inside the Render private network.
- [ ] Render **project members** can still reach private services. Treat `INTER_SERVICE_SECRET`, `ADMIN_SECRET`, and DB credentials as sensitive regardless of `pserv`.
- [ ] Do not convert private engines to public `web` services.

### 8. Other `sync: false` secrets (required)

Set in the dashboard for every service that declares them:

- [ ] `SETTLEMENT_CONTRACT_ID`
- [ ] `GOVERNANCE_CONTRACT_ID`
- [ ] `ADMIN_ADDRESS` / `ADMIN_SECRET` (gateway + settlement)
- [ ] `GOOGLE_CLIENT_ID` / `JWT` settings if required by your env schema beyond Blueprint defaults

---

## First-time deploy order

1. Create / link the Blueprint from this repo’s `render.yaml`.
2. In the Render Dashboard, fill all `sync: false` env vars **before** (or immediately after) first sync — especially `ALLOWED_ORIGINS` and `INTER_SERVICE_SECRET`.
3. Sync Blueprint and wait for Postgres + Redis to become ready.
4. Deploy services; confirm gateway health:
   - `GET /api/health`
   - `GET /api/health/all` (aggregated downstream status)
5. Run Prisma migrations against production (`npx prisma migrate deploy`) if not covered by a pre-deploy command.
6. Smoke-test a merchant/payment path from the frontend origin listed in `ALLOWED_ORIGINS`.

---

## Dashboard overrides

Render allows manual override of every env var at deploy time. Prefer dashboard values for secrets; keep non-secret wiring (`FX_ENGINE_URL`, ports, Stellar RPC defaults) in `render.yaml`.

After changing Blueprint scaling or plans, re-sync and verify the service Settings → Scaling page matches the intended HA/autoscaling config.

---

## Rollback / safety notes

- Zero-downtime deploys depend on a healthy `/api/health` for the public gateway.
- If a deploy fails CORS validation at boot, check that `ALLOWED_ORIGINS` is set and is not `*`.
- If inter-service calls return `401 UNAUTHORIZED`, verify `INTER_SERVICE_SECRET` matches on all four services.
