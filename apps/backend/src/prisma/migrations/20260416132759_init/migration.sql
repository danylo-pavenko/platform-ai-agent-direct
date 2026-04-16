-- CreateEnum
CREATE TYPE "conversation_channel" AS ENUM ('ig', 'tg');

-- CreateEnum
CREATE TYPE "conversation_state" AS ENUM ('bot', 'handoff', 'paused', 'closed');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('in', 'out', 'system');

-- CreateEnum
CREATE TYPE "message_sender" AS ENUM ('client', 'bot', 'manager', 'system');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('draft', 'submitted', 'confirmed', 'cancelled');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('card', 'transfer', 'cod');

-- CreateEnum
CREATE TYPE "prompt_author" AS ENUM ('human', 'meta_agent');

-- CreateEnum
CREATE TYPE "admin_role" AS ENUM ('owner', 'manager');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('ok', 'error');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "ig_user_id" TEXT,
    "tg_user_id" TEXT,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "channel" "conversation_channel" NOT NULL,
    "state" "conversation_state" NOT NULL DEFAULT 'bot',
    "last_message_at" TIMESTAMP(3),
    "handoff_reason" TEXT,
    "handed_off_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "sender" "message_sender" NOT NULL,
    "text" TEXT,
    "media_urls" JSONB,
    "shared_post" JSONB,
    "ig_message_id" TEXT,
    "claude_turn_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "items" JSONB NOT NULL,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "np_branch" TEXT NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "note" TEXT,
    "status" "order_status" NOT NULL DEFAULT 'draft',
    "submitted_to_manager_at" TIMESTAMP(3),
    "keycrm_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_prompts" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "author" "prompt_author" NOT NULL DEFAULT 'human',
    "author_user_id" UUID,
    "change_summary" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "admin_role" NOT NULL DEFAULT 'manager',
    "tg_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "keycrm_sync_runs" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "sync_status" NOT NULL,
    "counts" JSONB,
    "error_message" TEXT,

    CONSTRAINT "keycrm_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_ig_user_id_key" ON "clients"("ig_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tg_user_id_key" ON "clients"("tg_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_ig_message_id_key" ON "messages"("ig_message_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
