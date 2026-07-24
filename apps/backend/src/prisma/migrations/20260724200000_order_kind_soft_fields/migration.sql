-- CreateOrderKind + soft fields for create_local_order

CREATE TYPE "order_kind" AS ENUM ('product', 'service', 'callback', 'other');

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "kind" "order_kind" NOT NULL DEFAULT 'product';

ALTER TABLE "orders" ALTER COLUMN "city" DROP NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "np_branch" DROP NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "payment_method" DROP NOT NULL;
