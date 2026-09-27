# Contributing

## Local development with Docker Compose

Prerequisites:
- Docker Desktop or Docker Engine
- Docker Compose v2

Start the full stack:
```bash
docker compose up --build
```

Stop the stack:
```bash
docker compose down
```

Rebuild containers after changing dependencies or Docker configuration:
```bash
docker compose up --build
```

Data volumes are persisted in Docker named volumes for PostgreSQL and Redis. To reset them:
```bash
docker compose down -v
```

Common workflow:
1. Start the stack with `docker compose up --build`
2. Open the services at `http://localhost:3000`, `http://localhost:3001`, `http://localhost:3002`, and `http://localhost:3003`
3. Edit source files locally; the containers will reload the workspace through the mounted volume


## Continuous Integration

The repository uses **GitHub Actions** to automatically validate every pull request and push to the default branch.

- **Jobs executed**: lint, type‑check, test, migration rollback test, dependency audit, and PR title validation (Conventional Commits).
- **Caching**: pnpm store is cached to speed up installations.
- **Node.js version**: 20 (configured in the workflow).

### Running checks locally
```bash
pnpm install
pnpm lint               # Lint all packages
pnpm type-check         # Run TypeScript type checking
pnpm build              # Build the workspace packages
pnpm test               # Execute the test suite
pnpm test:load          # Run k6 load tests (requires k6 installed)
pnpm test:mutation      # Run mutation tests (Stryker)
pnpm audit --audit-level=high   # Security audit (fails on high/critical)
```

## Load testing

Run the k6 settlement-creation load test to ramp from 1 to 50 VUs over 60s:

```bash
# install k6 (macOS/Homebrew or apt/choco) and then:
k6 run tests/load/settlement-creation.js --env GATEWAY_URL=http://localhost:3000 --env MERCHANT_ID=test-merchant
```

Check p50/p95/p99 and error rate in k6 output. To capture BullMQ queue depth, query Redis `llen` for `bull:settlements:wait` during the test.

## Mutation testing

Run mutation tests with Stryker using the workspace script:

```bash
pnpm test:mutation
```

Target mutation score is >= 80% for critical modules (`settlement-amounts.ts`, `shared/validation/schemas.ts`). Address surviving mutants by either strengthening tests or fixing the implementation.

If any of these commands fail, fix the reported issues before pushing.

### Required status checks
When merging to `main` (or the default branch), enable branch protection with the following required checks:
- `lint`
- `type-check`
- `test`
- `migration-rollback-test`
- `audit`
- `pr-title`
Additionally, require at least one approving review and restrict force‑pushes on the protected branch.

For more details, see the CI workflow file at `.github/workflows/ci.yml`.
