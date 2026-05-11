-- Rename facebook_page_id → instagram_user_id.
-- entry[].id in Meta instagram-object webhooks is the IG Business Account ID,
-- not the Facebook Page ID. Rename for clarity.
ALTER TABLE "tenants"
  RENAME COLUMN "facebook_page_id" TO "instagram_user_id";

-- Recreate unique index under the new name.
DROP INDEX IF EXISTS "tenants_facebook_page_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_instagram_user_id_key"
  ON "tenants"("instagram_user_id")
  WHERE "instagram_user_id" IS NOT NULL;
