-- CreateTable
CREATE TABLE "sandbox_cases" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_cases_pkey" PRIMARY KEY ("id")
);
