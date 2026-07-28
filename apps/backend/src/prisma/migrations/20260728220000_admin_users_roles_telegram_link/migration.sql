-- Admin user profile / RBAC fields
ALTER TABLE "admin_users" ADD COLUMN "display_name" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "tg_username" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- One Telegram account ↔ one admin user
CREATE UNIQUE INDEX "admin_users_tg_user_id_key" ON "admin_users"("tg_user_id");

-- One-time Telegram link codes
CREATE TABLE "admin_telegram_link_codes" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_telegram_link_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_telegram_link_codes_code_key" ON "admin_telegram_link_codes"("code");
CREATE INDEX "admin_telegram_link_codes_admin_user_id_idx" ON "admin_telegram_link_codes"("admin_user_id");

ALTER TABLE "admin_telegram_link_codes"
  ADD CONSTRAINT "admin_telegram_link_codes_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate Conversation.handedOffTo from raw Telegram user id → AdminUser UUID
UPDATE "conversations" c
SET "handed_off_to" = a.id::text
FROM "admin_users" a
WHERE c."handed_off_to" IS NOT NULL
  AND c."handed_off_to" = a."tg_user_id";

-- Clear orphan TG ids that could not be resolved to an admin user
UPDATE "conversations"
SET "handed_off_to" = NULL
WHERE "handed_off_to" IS NOT NULL
  AND "handed_off_to" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
