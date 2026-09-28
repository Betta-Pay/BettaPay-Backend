- closes #650
- closes #651
- closes #652
- closes #654

### Changes Made:
- **Service Authentication**: Hardened the settlement-engine endpoints by explicitly injecting the `serviceAuth` preValidation hook.
- **Secured Routes**:
  - `GET /api/settlements`
  - `POST /api/settlements`
  - `POST /api/settlements/:id/retry`
  - `GET /api/settlements/reconcile`
- These routes now strictly mandate an internal service token (`x-service-token`) and will reject unauthenticated cross-service calls with a 401.
