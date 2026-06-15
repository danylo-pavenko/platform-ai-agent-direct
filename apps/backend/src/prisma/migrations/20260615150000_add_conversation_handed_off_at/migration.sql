-- Track when a conversation entered handoff so we can auto-return to the bot
-- after a configurable idle timeout (see handoff_return_to_bot_minutes setting).
ALTER TABLE "conversations" ADD COLUMN "handed_off_at" TIMESTAMP(3);
