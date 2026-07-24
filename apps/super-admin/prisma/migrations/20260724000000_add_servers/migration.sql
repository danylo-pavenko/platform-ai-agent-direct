-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'remote',
    "base_url" TEXT,
    "public_ip" TEXT NOT NULL,
    "shared_secret" TEXT,
    "max_tenants" INTEGER NOT NULL DEFAULT 12,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "servers_name_key" ON "servers"("name");

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "server_id" UUID;

-- CreateIndex
CREATE INDEX "tenants_server_id_idx" ON "tenants"("server_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed local worker and backfill existing tenants
INSERT INTO "servers" ("id", "name", "kind", "base_url", "public_ip", "shared_secret", "max_tenants", "status", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'local',
  'local',
  NULL,
  '127.0.0.1',
  NULL,
  12,
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

UPDATE "tenants"
SET "server_id" = (SELECT "id" FROM "servers" WHERE "name" = 'local' LIMIT 1)
WHERE "server_id" IS NULL;
