-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shopifyFulfillmentState" TEXT DEFAULT 'pending',
ADD COLUMN     "shopifySyncStatus" TEXT DEFAULT 'pending';
