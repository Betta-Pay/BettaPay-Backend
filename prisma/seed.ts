import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import crypto from "crypto";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function main() {
  const adminAddress = process.env.ADMIN_ADDRESS;
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminAddress || !adminSecret) {
    console.error("ADMIN_ADDRESS and ADMIN_SECRET must be set");
    process.exit(1);
  }

  const adminSecretHash = hashSecret(adminSecret);

  await prisma.merchant.upsert({
    where: { id: adminAddress },
    update: { secretHash: adminSecretHash },
    create: {
      id: adminAddress,
      name: "BettaPay Merchant LLC",
      ownerId: "admin-user-001",
      settings: { preferredAsset: "USDC", autoSettle: true },
      secretHash: adminSecretHash,
    },
  });

  console.log("Admin merchant seeded successfully");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
