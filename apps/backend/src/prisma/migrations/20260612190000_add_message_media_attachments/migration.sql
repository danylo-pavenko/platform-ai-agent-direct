-- Structured IG attachment metadata (kind, status, storage key) for admin playback UI.
ALTER TABLE "messages" ADD COLUMN "media_attachments" JSONB;
