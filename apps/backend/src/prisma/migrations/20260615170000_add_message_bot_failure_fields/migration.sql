-- Persist why the bot sent a canned fallback (visible in admin conversation view).

ALTER TABLE "messages" ADD COLUMN "bot_failure_code" TEXT;
ALTER TABLE "messages" ADD COLUMN "bot_failure_detail" TEXT;
