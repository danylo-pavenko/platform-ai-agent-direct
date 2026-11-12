-- Knowledge library card assets (images / files / links for agent send)
ALTER TABLE "knowledge_articles"
  ADD COLUMN IF NOT EXISTS "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;
