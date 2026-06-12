-- CreateEnum
CREATE TYPE "crm_sync_status" AS ENUM ('pending', 'synced', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "orders"
  ADD COLUMN "crm_sync_status" "crm_sync_status" NOT NULL DEFAULT 'pending',
  ADD COLUMN "crm_sync_error" TEXT,
  ADD COLUMN "crm_synced_at" TIMESTAMP(3);

-- Backfill: orders already in KeyCRM
UPDATE "orders"
SET "crm_sync_status" = 'synced',
    "crm_synced_at" = "created_at"
WHERE "keycrm_order_id" IS NOT NULL;
