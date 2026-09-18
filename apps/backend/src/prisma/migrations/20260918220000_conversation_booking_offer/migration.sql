-- Last get_available_slots offer for this conversation (injected into Claude session).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "booking_offer" JSONB;
