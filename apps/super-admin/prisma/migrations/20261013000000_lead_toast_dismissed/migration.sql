-- AlterTable
ALTER TABLE "landing_leads" ADD COLUMN "toast_dismissed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "landing_leads_status_toast_dismissed_at_idx" ON "landing_leads"("status", "toast_dismissed_at");
