-- CreateTable
CREATE TABLE "tracked_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destination_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_clicks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "link_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "referer" TEXT,
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,
    "is_human" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "country_code" TEXT,
    "region" TEXT,
    "clicked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "link_id" UUID,
    "ref_slug" TEXT,
    "name" TEXT,
    "email" TEXT,
    "instagram" TEXT,
    "messenger" TEXT,
    "message" TEXT,
    "plan" TEXT,
    "lang" TEXT,
    "page_url" TEXT,
    "referer" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "country" TEXT,
    "country_code" TEXT,
    "region" TEXT,
    "email_sent" BOOLEAN NOT NULL DEFAULT false,
    "email_error" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_links_slug_key" ON "tracked_links"("slug");

-- CreateIndex
CREATE INDEX "link_clicks_link_id_clicked_at_idx" ON "link_clicks"("link_id", "clicked_at");

-- CreateIndex
CREATE INDEX "link_clicks_link_id_is_human_idx" ON "link_clicks"("link_id", "is_human");

-- CreateIndex
CREATE INDEX "landing_leads_created_at_idx" ON "landing_leads"("created_at");

-- CreateIndex
CREATE INDEX "landing_leads_link_id_idx" ON "landing_leads"("link_id");

-- CreateIndex
CREATE INDEX "landing_leads_status_idx" ON "landing_leads"("status");

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "tracked_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_leads" ADD CONSTRAINT "landing_leads_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "tracked_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
