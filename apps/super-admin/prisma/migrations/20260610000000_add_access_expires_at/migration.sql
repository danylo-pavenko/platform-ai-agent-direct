-- Admin-panel access control for tenants.
-- NULL = unlimited (perpetual) access — default for all existing and new tenants.
-- A timestamp = access allowed until that moment (subscription / payment expiry).

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "access_expires_at" TIMESTAMP(3);
