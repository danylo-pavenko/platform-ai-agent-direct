-- Agent-mode foundation: leadgen brief surface, intent tracking, and
-- lead-scoped CRM field mappings.

-- ── 1. Conversation.intent ────────────────────────────────────────────────
-- Free-form text (not a DB enum) so new intent labels can roll out from
-- the tool schema without requiring a DB migration. Enum constraint is
-- enforced by the `classify_intent` JSON schema, not Postgres.
ALTER TABLE "conversations" ADD COLUMN "intent" TEXT;

-- ── 2. CrmFieldScope enum gains `lead` ────────────────────────────────────
ALTER TYPE "crm_field_scope" ADD VALUE 'lead';

-- ── 3. PresaleBrief status enum ───────────────────────────────────────────
CREATE TYPE "presale_brief_status" AS ENUM ('draft', 'submitted', 'synced', 'failed');

-- ── 4. PresaleBrief table ─────────────────────────────────────────────────
CREATE TABLE "presale_briefs" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,

    -- Identification
    "business_name" TEXT,
    "niche" TEXT,
    "role" TEXT,
    "client_type" TEXT,

    -- Request
    "services" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "goal" TEXT,
    "desired_result" TEXT,
    "kpi" TEXT,

    -- Current situation
    "current_activity" TEXT,
    "previous_contractors" TEXT,
    "pain_points" TEXT,

    -- Business
    "size" TEXT,
    "geo" TEXT,

    -- Channels / assets
    "website_url" TEXT,
    "instagram_url" TEXT,
    "other_channels" TEXT,

    -- Budget
    "budget_range" TEXT,
    "budget_period" TEXT,

    -- Timing
    "desired_start" TEXT,
    "deadlines" TEXT,

    -- Contacts
    "phone" TEXT,
    "email" TEXT,
    "preferred_channel" TEXT,
    "preferred_time" TEXT,

    -- Classification / service fields
    "segment" TEXT,
    "priority" TEXT,
    "source" TEXT,

    -- Quality (Phase B.1)
    "completeness_pct" INTEGER,
    "confidence" DOUBLE PRECISION,

    -- Catch-all for extra fields
    "raw_payload" JSONB,

    -- CRM link
    "keycrm_lead_id" TEXT,
    "status" "presale_brief_status" NOT NULL DEFAULT 'draft',

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presale_briefs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "presale_briefs_client_id_idx" ON "presale_briefs"("client_id");
CREATE INDEX "presale_briefs_status_idx" ON "presale_briefs"("status");
CREATE INDEX "presale_briefs_created_at_idx" ON "presale_briefs"("created_at");

ALTER TABLE "presale_briefs"
  ADD CONSTRAINT "presale_briefs_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "presale_briefs"
  ADD CONSTRAINT "presale_briefs_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
