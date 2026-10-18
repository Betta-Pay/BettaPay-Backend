# ADR-009: Consistent response envelope

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

BettaPay exposes several services through one API gateway. Returning raw
database objects from one endpoint and ad-hoc top-level fields from another
makes client error handling and observability unnecessarily complex.

## Decision

Successful responses use a `data` property. Collection endpoints may also
include a `pagination` property containing `page`, `limit`, `total`, and
`totalPages`. Error responses use the shared error envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A human-readable explanation",
    "requestId": "req_..."
  }
}
```

The `requestId` is safe to expose and lets support correlate a response with
the structured audit logs. Error `code` values are stable API identifiers;
messages may be improved without changing the code. Health endpoints are the
exception: liveness/readiness responses retain their purpose-built health
shape so load balancers can consume them without understanding business data.

## Consequences

Clients can deserialize all business responses through one generic envelope,
while pagination and error handling remain predictable. New routes must use
`{ data: ... }` (and the shared `createErrorResponse` helper) rather than
introducing a new top-level shape. Existing health and metrics contracts are
not changed.
