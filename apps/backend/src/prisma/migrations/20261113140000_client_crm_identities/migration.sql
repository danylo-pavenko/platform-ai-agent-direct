-- Multi-provider CRM client identities (salon cutover / hybrid by_action).
CREATE TABLE IF NOT EXISTS "client_crm_identities" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'phone',
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_crm_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_crm_identities_client_id_provider_key"
  ON "client_crm_identities"("client_id", "provider");

CREATE UNIQUE INDEX IF NOT EXISTS "client_crm_identities_provider_external_id_key"
  ON "client_crm_identities"("provider", "external_id");

CREATE INDEX IF NOT EXISTS "client_crm_identities_client_id_idx"
  ON "client_crm_identities"("client_id");

DO $$ BEGIN
  ALTER TABLE "client_crm_identities"
    ADD CONSTRAINT "client_crm_identities_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from denormalized Client.crmBuyerId / crmProvider.
INSERT INTO "client_crm_identities" (
  "id", "client_id", "provider", "external_id", "status", "source", "linked_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  c."id",
  c."crm_provider",
  c."crm_buyer_id",
  'active',
  'migration',
  COALESCE(c."crm_linked_at", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM "clients" c
WHERE c."crm_buyer_id" IS NOT NULL
  AND TRIM(c."crm_buyer_id") <> ''
  AND c."crm_provider" IS NOT NULL
  AND TRIM(c."crm_provider") <> ''
ON CONFLICT ("client_id", "provider") DO NOTHING;

-- Uniqueness moves to client_crm_identities(provider, external_id).
DROP INDEX IF EXISTS "clients_crm_buyer_id_key";
ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "clients_crm_buyer_id_key";
