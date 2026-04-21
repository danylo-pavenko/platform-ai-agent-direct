-- Phase B.4 — Time-to-first-response fields on Conversation.
-- `first_inbound_at`  — timestamp of the first client message on this convo.
-- `first_outbound_at` — timestamp of the first bot/manager reply.
-- Historic rows stay NULL; analytics query filters on IS NOT NULL.

ALTER TABLE "conversations"
  ADD COLUMN "first_inbound_at" TIMESTAMP(3),
  ADD COLUMN "first_outbound_at" TIMESTAMP(3);
