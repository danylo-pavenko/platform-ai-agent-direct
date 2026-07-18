-- CreateTable
CREATE TABLE "deploy_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "log_path" TEXT NOT NULL,
    "exit_code" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "deploy_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deploy_jobs_tenant_id_started_at_idx" ON "deploy_jobs"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "deploy_jobs_status_idx" ON "deploy_jobs"("status");

-- AddForeignKey
ALTER TABLE "deploy_jobs" ADD CONSTRAINT "deploy_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
