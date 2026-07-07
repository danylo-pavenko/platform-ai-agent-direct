CREATE TYPE "appointment_status" AS ENUM ('draft', 'confirmed', 'synced', 'failed', 'cancelled');

CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "branch_id" UUID,
    "services" JSONB NOT NULL,
    "scheduled_date" TEXT NOT NULL,
    "scheduled_time" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "comment" TEXT,
    "reference_photos" JSONB,
    "status" "appointment_status" NOT NULL DEFAULT 'draft',
    "crm_provider" TEXT NOT NULL,
    "crm_record_id" TEXT,
    "crm_sync_status" "crm_sync_status" NOT NULL DEFAULT 'pending',
    "crm_sync_error" TEXT,
    "crm_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_reference_photos" ADD CONSTRAINT "client_reference_photos_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
