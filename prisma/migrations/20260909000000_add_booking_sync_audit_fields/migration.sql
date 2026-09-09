-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "lastBookingAmount" DOUBLE PRECISION,
ADD COLUMN     "lastBookingAmountSource" TEXT,
ADD COLUMN     "lastBookingSyncAt" TIMESTAMP(3);
