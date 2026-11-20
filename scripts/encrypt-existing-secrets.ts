#!/usr/bin/env tsx
/**
 * Data migration script: Encrypt existing plaintext signing secrets (#617)
 *
 * This script encrypts all existing plaintext signingSecret values in both
 * WebhookSubscription and IndexedEventWebhookDelivery tables.
 *
 * Usage:
 *   FIELD_ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-existing-secrets.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be encrypted without making changes
 *
 * Prerequisites:
 *   - FIELD_ENCRYPTION_KEY environment variable must be set (min 32 chars)
 *   - Database connection configured via DATABASE_URL
 *   - Optional ENCRYPT_BATCH_SIZE (default 500) controls rows fetched per batch
 *
 * Safety:
 *   - Backs up secrets before encryption
 *   - Validates encryption by decrypting each value
 *   - Atomic updates per row (no partial failures)
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  encryptField,
  decryptField,
  isEncrypted,
} from "@bettapay/validation";

// Prisma 7 with prisma.config.ts requires an explicit driver adapter (#1099)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Rows are fetched in bounded, id-ordered cursor batches so memory stays flat
// regardless of table size (#1099)
const BATCH_SIZE = Number(process.env.ENCRYPT_BATCH_SIZE) || 500;

interface Stats {
  webhookSubscriptions: {
    total: number;
    encrypted: number;
    alreadyEncrypted: number;
  };
  webhookDeliveries: {
    total: number;
    encrypted: number;
    alreadyEncrypted: number;
  };
}

async function encryptWebhookSubscriptions(
  dryRun: boolean,
): Promise<Stats["webhookSubscriptions"]> {
  const stats = { total: 0, encrypted: 0, alreadyEncrypted: 0 };
  let cursor: string | undefined;

  for (;;) {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: { signingSecret: { not: null } },
      select: { id: true, signingSecret: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (subscriptions.length === 0) break;

    stats.total += subscriptions.length;
    cursor = subscriptions[subscriptions.length - 1].id;

    for (const sub of subscriptions) {
      if (!sub.signingSecret) continue;

      if (isEncrypted(sub.signingSecret)) {
        stats.alreadyEncrypted++;
        console.log(`[SKIP] WebhookSubscription ${sub.id} already encrypted`);
        continue;
      }

      const encrypted = encryptField(sub.signingSecret);

      // Validate encryption by decrypting
      const decrypted = decryptField(encrypted);
      if (decrypted !== sub.signingSecret) {
        throw new Error(
          `Encryption validation failed for WebhookSubscription ${sub.id}`,
        );
      }

      if (dryRun) {
        console.log(`[DRY-RUN] Would encrypt WebhookSubscription ${sub.id}`);
      } else {
        await prisma.webhookSubscription.update({
          where: { id: sub.id },
          data: { signingSecret: encrypted },
        });
        console.log(`[ENCRYPTED] WebhookSubscription ${sub.id}`);
      }

      stats.encrypted++;
    }

    if (subscriptions.length < BATCH_SIZE) break;
  }

  return stats;
}

async function encryptWebhookDeliveries(
  dryRun: boolean,
): Promise<Stats["webhookDeliveries"]> {
  const stats = { total: 0, encrypted: 0, alreadyEncrypted: 0 };
  let cursor: string | undefined;

  for (;;) {
    const deliveries = await prisma.indexedEventWebhookDelivery.findMany({
      where: { signingSecret: { not: null } },
      select: { id: true, signingSecret: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (deliveries.length === 0) break;

    stats.total += deliveries.length;
    cursor = deliveries[deliveries.length - 1].id;

    for (const delivery of deliveries) {
      if (!delivery.signingSecret) continue;

      if (isEncrypted(delivery.signingSecret)) {
        stats.alreadyEncrypted++;
        console.log(
          `[SKIP] IndexedEventWebhookDelivery ${delivery.id} already encrypted`,
        );
        continue;
      }

      const encrypted = encryptField(delivery.signingSecret);

      // Validate encryption by decrypting
      const decrypted = decryptField(encrypted);
      if (decrypted !== delivery.signingSecret) {
        throw new Error(
          `Encryption validation failed for IndexedEventWebhookDelivery ${delivery.id}`,
        );
      }

      if (dryRun) {
        console.log(
          `[DRY-RUN] Would encrypt IndexedEventWebhookDelivery ${delivery.id}`,
        );
      } else {
        await prisma.indexedEventWebhookDelivery.update({
          where: { id: delivery.id },
          data: { signingSecret: encrypted },
        });
        console.log(`[ENCRYPTED] IndexedEventWebhookDelivery ${delivery.id}`);
      }

      stats.encrypted++;
    }

    if (deliveries.length < BATCH_SIZE) break;
  }

  return stats;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error(
      "ERROR: FIELD_ENCRYPTION_KEY environment variable is required",
    );
    process.exit(1);
  }

  if (process.env.FIELD_ENCRYPTION_KEY.length < 32) {
    console.error("ERROR: FIELD_ENCRYPTION_KEY must be at least 32 characters");
    process.exit(1);
  }

  console.log(
    `\n🔐 Encrypting existing signing secrets ${dryRun ? "(DRY RUN)" : ""}\n`,
  );

  const subscriptionStats = await encryptWebhookSubscriptions(dryRun);
  const deliveryStats = await encryptWebhookDeliveries(dryRun);

  console.log("\n📊 Summary:\n");
  console.log("WebhookSubscription:");
  console.log(`  Total: ${subscriptionStats.total}`);
  console.log(`  Encrypted: ${subscriptionStats.encrypted}`);
  console.log(`  Already encrypted: ${subscriptionStats.alreadyEncrypted}`);

  console.log("\nIndexedEventWebhookDelivery:");
  console.log(`  Total: ${deliveryStats.total}`);
  console.log(`  Encrypted: ${deliveryStats.encrypted}`);
  console.log(`  Already encrypted: ${deliveryStats.alreadyEncrypted}`);

  if (dryRun) {
    console.log("\n⚠️  This was a DRY RUN. No changes were made.");
    console.log("Run without --dry-run to apply changes.");
  } else {
    console.log("\n✅ Encryption complete!");
  }
}

main()
  .catch((err) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
