-- Rename keycrm_sync_runs → crm_sync_runs and add provider metadata
ALTER TABLE "keycrm_sync_runs" RENAME TO "crm_sync_runs";

ALTER TABLE "crm_sync_runs" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'keycrm';
ALTER TABLE "crm_sync_runs" ADD COLUMN "sync_type" TEXT NOT NULL DEFAULT 'catalog';
ALTER TABLE "crm_sync_runs" ADD COLUMN "artifacts" JSONB;

-- Branch source enum
CREATE TYPE "branch_source" AS ENUM ('manual', 'crm');

-- Branches (salon locations)
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" "branch_source" NOT NULL DEFAULT 'manual',
    "crm_provider" TEXT,
    "crm_external_id" TEXT,
    "crm_synced_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branches_slug_key" ON "branches"("slug");
CREATE UNIQUE INDEX "branches_crm_provider_crm_external_id_key" ON "branches"("crm_provider", "crm_external_id");

-- Conversation → branch (client picked location)
ALTER TABLE "conversations" ADD COLUMN "branch_id" UUID;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Client reference photos
CREATE TABLE "client_reference_photos" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID,
    "branch_id" UUID,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT,
    "note" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_reference_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_reference_photos_client_id_created_at_idx"
    ON "client_reference_photos"("client_id", "created_at");

ALTER TABLE "client_reference_photos" ADD CONSTRAINT "client_reference_photos_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_reference_photos" ADD CONSTRAINT "client_reference_photos_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
