-- Manager-assigned lead quality (1–5) + optional rationale note.
-- Nullable: historic and unrated conversations coexist with new ones.
ALTER TABLE "conversations"
  ADD COLUMN "brief_quality" INTEGER,
  ADD COLUMN "brief_quality_note" TEXT;
