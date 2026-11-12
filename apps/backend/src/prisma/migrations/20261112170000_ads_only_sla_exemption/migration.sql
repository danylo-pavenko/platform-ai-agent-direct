-- Ads-only bot exemption after SLA reclaim + dual-SLA job queue.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "ads_only_bot_assumed_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "handoff_sla_jobs" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "run_at" TIMESTAMP(3) NOT NULL,
  "status" "FollowUpJobStatus" NOT NULL DEFAULT 'pending',
  "scheduled_from" TIMESTAMP(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "handoff_sla_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "handoff_sla_jobs_status_run_at_idx"
  ON "handoff_sla_jobs"("status", "run_at");

CREATE INDEX IF NOT EXISTS "handoff_sla_jobs_conversation_id_status_idx"
  ON "handoff_sla_jobs"("conversation_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'handoff_sla_jobs_conversation_id_fkey'
  ) THEN
    ALTER TABLE "handoff_sla_jobs"
      ADD CONSTRAINT "handoff_sla_jobs_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
