-- CreateEnum
CREATE TYPE "crm_field_scope" AS ENUM ('buyer', 'order');

-- CreateTable
CREATE TABLE "crm_field_mappings" (
    "id" UUID NOT NULL,
    "local_key" TEXT NOT NULL,
    "crm_field_key" TEXT NOT NULL,
    "scope" "crm_field_scope" NOT NULL DEFAULT 'buyer',
    "label" TEXT NOT NULL,
    "prompt_hint" TEXT,
    "extract_type" TEXT NOT NULL DEFAULT 'text',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_field_mappings_local_key_key" ON "crm_field_mappings"("local_key");
