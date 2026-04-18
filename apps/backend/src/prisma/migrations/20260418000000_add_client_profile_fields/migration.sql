-- Add Instagram profile and customer delivery fields to clients table.
-- These are all nullable so existing rows are unaffected.

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "ig_username"       TEXT,
  ADD COLUMN IF NOT EXISTS "ig_full_name"      TEXT,
  ADD COLUMN IF NOT EXISTS "phone"             TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_city"     TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_np_branch" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_np_type"  TEXT;
