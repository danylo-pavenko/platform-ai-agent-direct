-- Instagram story replies / mentions / reactions context on messages
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "ig_context" JSONB;
