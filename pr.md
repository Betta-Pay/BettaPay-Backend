# fix: validate, limit, and escape merchant settings business data (#552)

Closes #552

## Summary

- **Length Caps & Constraints**: Enforced length boundaries and validation on merchant settings business data fields inside Zod schemas:
  - `businessName`: limited to max 100 characters.
  - `supportEmail`: validated format and limited to max 255 characters.
  - `supportAddress`: limited to max 255 characters.
  - `tier`: limited to max 50 characters.
- **XSS Mitigation**: Implemented an HTML escaping function `escapeHtml` that transforms HTML special characters (`&`, `<`, `>`, `"`, `'`, `/`) inside free-text input fields to neutralize potential XSS payloads.
- **Race Condition Fix**: Resolved a test suite race condition in `merchant-settings.test.ts` where `generateTestJwt` was called before the Fastify app finished loading asynchronous decorators (fixed by calling `await app.ready()`).
- **Tests**: Added validation schema unit tests in `schemas.test.ts` and integration route tests in `merchant-settings.test.ts`.

## Files changed

**Backend Services:**
- [merchant-settings.test.ts](file:///c:/Users/SHATTER/.vscode/BettaPay-Backend/services/api-gateway/src/merchant-settings.test.ts) — added route integration tests for invalid input validation and XSS neutralization, fixed async boot hook race.

**Shared Libraries:**
- [schemas.ts](file:///c:/Users/SHATTER/.vscode/BettaPay-Backend/shared/validation/schemas.ts) — added `escapeHtml` utility and bounded the settings properties inside Zod schemas.
- [schemas.test.ts](file:///c:/Users/SHATTER/.vscode/BettaPay-Backend/shared/validation/schemas.test.ts) — added unit tests for the settings validation and escaping rules.

## Test Coverage

- ✅ Validation allows valid fields and parses them successfully
- ✅ Validation rejects invalid formats (e.g. invalid emails) returning `400 Bad Request`
- ✅ Validation rejects fields exceeding length boundaries returning `400 Bad Request`
- ✅ HTML inputs are escaped in free-text fields, returned in JSON payload, and persisted to DB safely
