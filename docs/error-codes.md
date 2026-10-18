# Error-code catalog

All HTTP services use the `{ error: { code, message, details?, reqId? } }` envelope from `@bettapay/validation`. Clients should branch on `error.code`, not on message text.

| Code | Meaning |
| --- | --- |
| `UNAUTHORIZED` | Authentication is missing or invalid. |
| `FORBIDDEN` | The caller is authenticated but not allowed to perform the operation. |
| `NOT_FOUND` | The requested resource does not exist. |
| `VALIDATION_ERROR` | Request body, query, or path parameters failed validation. |
| `INVALID_REQUEST` | The request is syntactically valid but cannot be processed. |
| `RATE_LIMITED` | A rate or concurrency limit was exceeded. |
| `REQUEST_TIMEOUT` | The request exceeded its local processing deadline. |
| `GATEWAY_TIMEOUT` | A downstream service did not respond in time. |
| `INTERNAL_ERROR` | An unexpected server-side failure occurred. |
| `UNSUPPORTED_CURRENCY_PAIR` | The requested FX pair is not supported. |
| `INVALID_AMOUNT` | A monetary amount is invalid. |
| `INVALID_QUERY` | Query parameters are invalid or inconsistent. |
| `PAYLOAD_TOO_LARGE` | The request body exceeded the route's configured limit (413). |
| `INVALID_ORIGIN` | The request origin is not allowed. |
| `CONCURRENCY_EXCEEDED` | Per-merchant or worker concurrency has been exhausted. |
| `MERCHANT_SUSPENDED` | The merchant is suspended. |
| `MERCHANT_STATE_CONFLICT` | The requested merchant state transition is already satisfied. |
| `QUOTE_TOO_YOUNG` / `QUOTE_TOO_OLD` | The FX quote is outside its permitted age window. |

The authoritative list is `shared/validation/index.ts`; update this page whenever `ErrorCodes` changes.
