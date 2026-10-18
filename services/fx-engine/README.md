# FX Engine

Exchange-rate and quote service for BettaPay. Runs on port `3002`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/rates` | Latest cached rates with cache metadata |
| `GET` | `/api/rates/history` | Historical rate at a timestamp |
| `GET` | `/api/currencies` | Supported currency codes |
| `GET` | `/api/quote` | Compute a quote; returns a `quoteId` for later verification |
| `POST` | `/api/quote/verify` | Verify a quote is still valid |

## Quote validation

`GET /api/quote` rejects an `amount` that is zero, negative, `NaN`, `Infinity`
or not a plain decimal string with a `400 VALIDATION_ERROR` whose details name
the `amount` field. Validation runs before rate resolution, so invalid amounts
never reach the cache or the arithmetic path.

## Request body limit

`POST /api/quote/verify` has a route-level JSON body limit. It is configurable
through `FX_QUOTE_BODY_LIMIT_BYTES` (bytes, default `1048576` / 1 MiB) rather
than hardcoded in the route.

An oversized body is rejected with HTTP `413` and the shared error envelope:

```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Request body exceeds the maximum allowed size"
  }
}
```

Bodies at or below the limit are parsed and handled normally.

## Tests

```sh
pnpm --filter fx-engine test
```
