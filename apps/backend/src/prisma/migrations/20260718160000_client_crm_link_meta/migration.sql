-- AlterTable
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "crm_provider" TEXT;
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "crm_linked_at" TIMESTAMP(3);
