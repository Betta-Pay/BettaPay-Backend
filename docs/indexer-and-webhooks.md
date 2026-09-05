# Indexer polling & settlement webhook payloads

Reference for the behaviour behind issues **#535–#538**. The mechanisms
described here are implemented in `services/indexer/src/index.ts` and
`services/settlement-engine/src/index.ts`; this document is the missing
written contract for them.

## Rate-limit backoff (#535)

The polling loop is resilient to `429 Too Many Requests` from the Stellar
RPC / Horizon endpoint. On a poll error the backoff is recomputed by
`calculateBackoffAfterError` → `calculateBackoffAfter429`:

| Condition | Next backoff |
|---|---|
| `429` **with** a valid `Retry-After` header (seconds, `> 0`) | `min(Retry-After × 1000, MAX_BACKOFF_INTERVAL_MS)` |
| `429` **without** (or with a bogus) `Retry-After` | `min(currentBackoff × 2, MAX_BACKOFF_INTERVAL_MS)` |
| any non-`429` error | `min(currentBackoff × 2, MAX_BACKOFF_INTERVAL_MS)` |
| a successful poll | `max(BASE_BACKOFF (1 s), floor(currentBackoff / 2))` |

Both the object (`err.response.headers['retry-after']`) and the fetch-style
(`err.response.headers.get('retry-after')`) header shapes are handled. The
current value is exported on the `indexer_poll_backoff_ms` Prometheus gauge.

**No ledger loss:** the poll *cursor is only advanced after a page has been
persisted*. A backed-off cycle simply retries from the same cursor, so a
rate-limit storm delays indexing but never skips ledgers.

## Start position & backfill (#536, #537)

`discoverStartLedger()` picks the first ledger the poll loop reads, in this
priority order:

1. **`INDEX_FROM_LEDGER`** env var — explicit manual override (invalid values
   are logged and ignored).
2. **Resume** — `max(ledger) + 1` from the `indexedEvent` table. This is the
   persisted cursor: it survives restarts and crashes because it is derived
   from committed rows, not in-memory state, so there are **no duplicate or
   lost ledgers at a restart boundary**.
3. **Fresh deployment** — `max(1, networkTip − INITIAL_BACKFILL_LEDGERS)`.
   A brand-new indexer (empty `indexedEvent` table) backfills a configurable
   window of history so a merchant onboarded just before deployment still
   gets their earlier payments. Set `INITIAL_BACKFILL_LEDGERS` to size the
   window.
4. **RPC failure fallback** — ledger `1`.

The poll loop itself is interval-driven with adaptive backoff (see above)
rather than a long-lived stream subscription; catch-up drains multiple pages
per cycle until it reaches the tip, bounded by the per-cycle timeout.

### Relevant env vars

| Var | Purpose |
|---|---|
| `INDEX_FROM_LEDGER` | Force the start ledger (manual replay / recovery). |
| `INITIAL_BACKFILL_LEDGERS` | History window a fresh deployment backfills. |
| `MAX_BACKOFF_INTERVAL_MS` | Ceiling for the poll backoff. |

## Settlement webhook payloads (#538)

`settlement.completed` and `settlement.failed` webhook events carry a
**projected** payload (built by `buildSettlementWebhookData`), not the raw
database row — internal columns (`idempotencyKey*`, `webhookHeaders`) are
never sent. `webhookUrl` (the delivery target itself, which can carry an
internal Vercel preview / ngrok / staging hostname) is excluded from the
payload for the same reason (#608) — it is used only for internal delivery
routing and is never mirrored back to the merchant that configured it.

```jsonc
{
  "version": "1.0",
  "event": {
    "event": "settlement.completed",
    "data": {
      "id": "set_…",
      "merchantId": "…",
      "status": "completed",
      "asset": "USDC",
      "grossAmount": "500.0000000",
      "feeAmount": "4.5000000",
      "netAmount": "495.5000000",
      "feeBps": 100,
      "feeVersion": "1.0",          // top-level, for quick reconciliation
      "feeSnapshot": {              // full fee audit trail (#538)
        "feeBpsApplied": 90,        // effective bps after any discount
        "discountApplied": 10,      // volume-discount bps subtracted
        "monthlyVolumeAtTime": "…",
        "feeVersion": "1.0"
      },
      "createdAt": "…",
      "completedAt": "…"
    }
  }
}
```

A merchant can verify fee computation from the webhook alone:
`feeAmount == grossAmount × feeBpsApplied / 10_000` and
`netAmount == grossAmount − feeAmount`. `feeSnapshot` is `null` only for
settlements that predate the fee-snapshot migration.
