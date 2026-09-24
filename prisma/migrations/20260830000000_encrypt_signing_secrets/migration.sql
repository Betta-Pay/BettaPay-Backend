-- Migration: Encrypt webhook signing secrets (#617)
-- This migration prepares for encryption of signingSecret fields in
-- IndexedEventWebhookDelivery table. The actual encryption is handled
-- by application code using shared/validation/encryption.ts.
--
-- NOTE: A separate data migration script must be run to encrypt existing
-- plaintext secrets. See: prisma/data-migrations/encrypt-existing-secrets.ts
--
-- No schema changes are required since signingSecret is already String?

-- Add a comment to document the encryption requirement
COMMENT ON COLUMN "IndexedEventWebhookDelivery"."signingSecret" 
  IS 'Encrypted webhook HMAC secret (AES-256-GCM). Encrypted at rest via shared/validation/encryption.ts (#617)';

COMMENT ON COLUMN "WebhookSubscription"."signingSecret"
  IS 'Encrypted webhook HMAC secret (AES-256-GCM). Encrypted at rest via shared/validation/encryption.ts (#617)';
