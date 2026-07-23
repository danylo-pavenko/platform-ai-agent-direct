-- Soft session compact: store summary when teach history is trimmed
ALTER TABLE "meta_agent_teach_sessions"
  ADD COLUMN IF NOT EXISTS "session_summary" TEXT;
