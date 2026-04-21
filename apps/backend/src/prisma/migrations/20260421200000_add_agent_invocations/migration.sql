-- Agent invocation analytics: one row per askClaude() call.
-- Written fire-and-forget so failures here never block the bot response.

CREATE TYPE "agent_channel" AS ENUM ('ig', 'tg', 'sandbox', 'meta_agent', 'supervisor');

CREATE TABLE "agent_invocations" (
    "id" UUID NOT NULL,
    "channel" "agent_channel" NOT NULL,
    "conversation_id" UUID,
    "client_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "fallback_reason" TEXT,
    "error_message" TEXT,
    "input_chars" INTEGER NOT NULL,
    "output_chars" INTEGER NOT NULL,

    CONSTRAINT "agent_invocations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_invocations_started_at_idx" ON "agent_invocations"("started_at");
CREATE INDEX "agent_invocations_channel_started_at_idx" ON "agent_invocations"("channel", "started_at");
