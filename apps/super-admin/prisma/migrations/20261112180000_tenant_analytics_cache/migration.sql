-- CreateTable
CREATE TABLE "tenant_analytics_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_analytics_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_analytics_cache_period_fetched_at_idx" ON "tenant_analytics_cache"("period", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_analytics_cache_tenant_id_period_key" ON "tenant_analytics_cache"("tenant_id", "period");

-- AddForeignKey
ALTER TABLE "tenant_analytics_cache" ADD CONSTRAINT "tenant_analytics_cache_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
