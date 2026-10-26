-- Tenant calendar events (casting / promo / hiring / collab) + conversation soft pin.
CREATE TYPE "tenant_event_kind" AS ENUM ('casting', 'promo', 'hiring', 'collab', 'other');
CREATE TYPE "tenant_event_status" AS ENUM ('draft', 'active', 'paused', 'archived');
CREATE TYPE "tenant_event_on_match" AS ENUM ('inform', 'handoff', 'continue_funnel');

CREATE TABLE "tenant_events" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "tenant_event_kind" NOT NULL,
    "status" "tenant_event_status" NOT NULL DEFAULT 'draft',
    "event_starts_at" TIMESTAMP(3),
    "event_ends_at" TIMESTAMP(3),
    "open_from" TIMESTAMP(3),
    "open_until" TIMESTAMP(3),
    "summary" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "agent_instructions" TEXT NOT NULL,
    "on_match" "tenant_event_on_match" NOT NULL DEFAULT 'inform',
    "handoff_reason" TEXT,
    "closed_reply_hint" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_events_status_open_until_idx" ON "tenant_events"("status", "open_until");
CREATE INDEX "tenant_events_status_open_from_idx" ON "tenant_events"("status", "open_from");

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "matched_event_id" UUID;

CREATE INDEX IF NOT EXISTS "conversations_matched_event_id_idx" ON "conversations"("matched_event_id");

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_matched_event_id_fkey"
  FOREIGN KEY ("matched_event_id") REFERENCES "tenant_events"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
