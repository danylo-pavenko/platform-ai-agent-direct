-- AlterTable servers: per-worker S3 backup settings
ALTER TABLE "servers" ADD COLUMN "s3_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "servers" ADD COLUMN "s3_endpoint" TEXT;
ALTER TABLE "servers" ADD COLUMN "s3_bucket" TEXT;
ALTER TABLE "servers" ADD COLUMN "s3_region" TEXT NOT NULL DEFAULT 'us-east-1';
ALTER TABLE "servers" ADD COLUMN "s3_force_path_style" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "servers" ADD COLUMN "s3_access_key" TEXT;
ALTER TABLE "servers" ADD COLUMN "s3_secret_enc" TEXT;
ALTER TABLE "servers" ADD COLUMN "s3_last_test_at" TIMESTAMP(3);
ALTER TABLE "servers" ADD COLUMN "s3_last_test_ok" BOOLEAN;

-- CreateTable
CREATE TABLE "tenant_backups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "server_id" UUID,
    "storage_key" TEXT NOT NULL,
    "bytes" BIGINT,
    "sha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_backups_tenant_id_created_at_idx" ON "tenant_backups"("tenant_id", "created_at");
CREATE INDEX "tenant_backups_server_id_created_at_idx" ON "tenant_backups"("server_id", "created_at");
CREATE INDEX "tenant_backups_status_idx" ON "tenant_backups"("status");

-- AddForeignKey
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_backups" ADD CONSTRAINT "tenant_backups_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
