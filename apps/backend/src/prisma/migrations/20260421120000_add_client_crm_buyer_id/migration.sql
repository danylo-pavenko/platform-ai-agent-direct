-- AlterTable
ALTER TABLE "clients" ADD COLUMN "crm_buyer_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "clients_crm_buyer_id_key" ON "clients"("crm_buyer_id");
