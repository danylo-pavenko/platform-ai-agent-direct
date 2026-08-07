-- AlterEnum: add booking to order_kind
ALTER TYPE "order_kind" ADD VALUE IF NOT EXISTS 'booking';
