-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "admin_users_last_login_at_idx" ON "admin_users"("last_login_at");
