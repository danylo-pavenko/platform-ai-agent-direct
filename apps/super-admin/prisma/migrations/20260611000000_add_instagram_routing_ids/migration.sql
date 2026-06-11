-- Extra Instagram IDs that may appear in webhook payloads (recipient.id, ig_id, etc.)
-- The Graph API instagram_business_account.id often differs from webhook recipient.id.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "instagram_routing_ids" JSONB NOT NULL DEFAULT '[]';
