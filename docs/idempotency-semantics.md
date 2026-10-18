# Idempotency semantics

The gateway accepts an `Idempotency-Key` header on payment and settlement
creation requests. Keys are scoped to the authenticated merchant and endpoint;
the same key may therefore be used independently for `/api/payments` and
`/api/settlements`.

| Endpoint | Operation | Replay result | Conflict result |
| --- | --- | --- | --- |
| `POST /api/payments` | Creates one payment session | Returns the original response and status | `409` when the key is reused with a different request fingerprint |
| `POST /api/settlements` | Creates one settlement | Returns the original response and status | `409` when the key is reused with a different request fingerprint |

The key is trimmed, must be non-empty, and is limited to 255 characters. A
request without a key is processed normally but is not replay-safe. A key is
stored with a request fingerprint and the resulting response; it remains
reserved for 24 hours. In-progress requests are represented by the persisted
record, so retries never create a second payment or settlement.

Idempotency is intentionally applied only to creation endpoints. Reads,
status transitions, retries, and administrative operations are not made
idempotent by this mechanism; callers should use the resource status and the
endpoint-specific transition rules for those operations.

Clients should retry a timed-out request with the same key. They should not
generate a new key unless they intend to create a new resource. A `409` means
the key was already used for a different payload and requires operator/client
correction rather than an automatic retry.

## Route ownership

Gateway and settlement route ownership is recorded in
`services/api-gateway/src/routes/gateway.routes.ts` and
`services/api-gateway/src/routes/settlement.routes.ts`. These manifests are
the extraction boundary: handlers can move out of the bootstrap incrementally
without changing the public paths or idempotency contract.
