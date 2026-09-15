-- CreateTable
CREATE TABLE "webhook_inbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "object_type" TEXT,
    "status" TEXT NOT NULL,
    "routing_candidate_ids" JSONB NOT NULL DEFAULT '[]',
    "debug_candidate_ids" JSONB NOT NULL DEFAULT '[]',
    "entry_summary" JSONB,
    "matched_tenant_ids" JSONB NOT NULL DEFAULT '[]',
    "forward_results" JSONB NOT NULL DEFAULT '[]',
    "signature_present" BOOLEAN NOT NULL DEFAULT false,
    "raw_body_truncated" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_inbox_events_received_at_idx" ON "webhook_inbox_events"("received_at");

-- CreateIndex
CREATE INDEX "webhook_inbox_events_status_idx" ON "webhook_inbox_events"("status");
