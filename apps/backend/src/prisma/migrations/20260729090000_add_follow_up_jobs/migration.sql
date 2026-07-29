-- CreateEnum
CREATE TYPE "FollowUpJobStatus" AS ENUM ('pending', 'processing', 'done', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "follow_up_jobs" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpJobStatus" NOT NULL DEFAULT 'pending',
    "scheduled_from" TIMESTAMP(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_up_jobs_status_run_at_idx" ON "follow_up_jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "follow_up_jobs_conversation_id_status_idx" ON "follow_up_jobs"("conversation_id", "status");

-- AddForeignKey
ALTER TABLE "follow_up_jobs" ADD CONSTRAINT "follow_up_jobs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
