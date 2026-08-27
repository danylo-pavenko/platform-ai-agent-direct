-- AlterTable
ALTER TABLE "deploy_jobs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'deploy';

-- CreateIndex
CREATE INDEX "deploy_jobs_tenant_id_kind_started_at_idx" ON "deploy_jobs"("tenant_id", "kind", "started_at");
