-- Soft open agenda (logical unfinished thread) across civil-day cuts / IG import.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "open_agenda" JSONB;
