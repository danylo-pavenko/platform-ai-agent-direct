-- CreateEnum
CREATE TYPE "meta_agent_teach_message_role" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "meta_agent_teach_sessions" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "title" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3),

    CONSTRAINT "meta_agent_teach_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_agent_teach_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "meta_agent_teach_message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "suggested_diffs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_agent_teach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meta_agent_teach_sessions_admin_user_id_is_active_idx" ON "meta_agent_teach_sessions"("admin_user_id", "is_active");

-- CreateIndex
CREATE INDEX "meta_agent_teach_sessions_admin_user_id_last_message_at_idx" ON "meta_agent_teach_sessions"("admin_user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "meta_agent_teach_messages_session_id_created_at_idx" ON "meta_agent_teach_messages"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "meta_agent_teach_sessions" ADD CONSTRAINT "meta_agent_teach_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_agent_teach_messages" ADD CONSTRAINT "meta_agent_teach_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "meta_agent_teach_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
