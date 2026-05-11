-- Add Meta/Facebook webhook routing fields to tenants
-- facebookPageId: the FB Page ID used to route inbound webhooks to this tenant
-- facebookAppSecret: this tenant's Meta App Secret for HMAC verification in the hub

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "facebook_page_id"    TEXT,
  ADD COLUMN IF NOT EXISTS "facebook_app_secret"  TEXT;

-- Unique index so two tenants can't accidentally share the same Page ID
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_facebook_page_id_key"
  ON "tenants"("facebook_page_id")
  WHERE "facebook_page_id" IS NOT NULL;
