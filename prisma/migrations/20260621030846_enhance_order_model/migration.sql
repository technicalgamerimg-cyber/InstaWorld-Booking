/*
  Warnings:

  - Added the required column `shop` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "bookingStatus" TEXT DEFAULT 'pending',
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "financialStatus" TEXT,
ADD COLUMN     "fulfillmentStatus" TEXT,
ADD COLUMN     "lineItems" JSONB,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "shop" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
