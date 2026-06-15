-- AlterTable
ALTER TABLE "orders"
  ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived_at" TIMESTAMP(3);

-- Backfill: locally cancelled orders are treated as archived in the admin list.
UPDATE "orders"
SET "is_archived" = true,
    "archived_at" = COALESCE("submitted_to_manager_at", "created_at")
WHERE "status" = 'cancelled';
