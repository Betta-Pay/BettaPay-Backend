- closes #649
- closes #653

### Changes Made:
- **`serviceAuth`**: Registered the `serviceAuth` Fastify decorator in the settlement-engine bootstrap to enforce internal service-to-service authentication.
- **Routes**: Hardened `GET /api/settlements/reconcile/report` by appending the `serviceAuth` preValidation hook, ensuring only authorized microservices can pull reconciliation reports.
