-- Instagram CTD / ads referral attribution on client + conversation.
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "ig_ad_referral" JSONB,
  ADD COLUMN IF NOT EXISTS "ig_ad_first_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ig_ad_last_at" TIMESTAMP(3);

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "ig_ad_referral" JSONB;
