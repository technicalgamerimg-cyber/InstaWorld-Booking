-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "courierName" TEXT,
ADD COLUMN     "shipmentStatus" TEXT DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "shipperAddress" TEXT,
ADD COLUMN     "shipperCity" TEXT,
ADD COLUMN     "shipperName" TEXT,
ADD COLUMN     "shipperPhone" TEXT;
