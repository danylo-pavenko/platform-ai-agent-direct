-- Open booking funnel across civil-day history cuts (overnight contact collection).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "booking_funnel" JSONB;
