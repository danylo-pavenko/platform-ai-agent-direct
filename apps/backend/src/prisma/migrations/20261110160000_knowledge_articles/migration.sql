CREATE TYPE "knowledge_article_status" AS ENUM ('draft', 'active');

CREATE TABLE "knowledge_articles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "knowledge_article_status" NOT NULL DEFAULT 'draft',
    "author" "prompt_author" NOT NULL DEFAULT 'human',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_articles_slug_key" ON "knowledge_articles"("slug");
CREATE INDEX "knowledge_articles_status_idx" ON "knowledge_articles"("status");
