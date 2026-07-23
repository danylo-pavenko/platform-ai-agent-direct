-- Smart-trigger: track one silence follow-up per quiet window
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "follow_up_sent_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "conversations_state_follow_up_sent_at_last_message_at_idx"
  ON "conversations" ("state", "follow_up_sent_at", "last_message_at");
