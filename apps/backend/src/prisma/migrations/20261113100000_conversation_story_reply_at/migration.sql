-- Sticky marker: this thread started with (or includes) a reply to an Instagram Story.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "story_reply_at" TIMESTAMP(3);
