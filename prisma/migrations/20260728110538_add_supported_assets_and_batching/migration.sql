-- CreateTable
CREATE TABLE "SupportedAsset" (
    "code" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportedAsset_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "SettlementBatch" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "totalGross" TEXT NOT NULL,
    "totalFees" TEXT NOT NULL,
    "totalNet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementBatch_pkey" PRIMARY KEY ("id")
);

-- Seed initial supported assets
INSERT INTO "SupportedAsset" ("code", "contractId", "decimals", "name", "isActive", "updatedAt") VALUES
('USDC', 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', 7, 'USD Coin', true, NOW()),
('EURT', 'GAP5LETOV6YIE62YAM56STDANPRDO7ZFDBGSNHJQIYGGKSMOZAHOOS2S', 7, 'Euro Token', true, NOW()),
('XLMS', 'native', 7, 'Stellar Lumens', true, NOW());
