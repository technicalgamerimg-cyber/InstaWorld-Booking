-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "shipperAddress" TEXT,
ADD COLUMN     "shipperName" TEXT,
ADD COLUMN     "shipperPhone" TEXT;

-- CreateTable
CREATE TABLE "Loadsheet" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderCount" INTEGER NOT NULL,
    "totalCOD" DOUBLE PRECISION NOT NULL,
    "orderIds" JSONB NOT NULL,
    "filename" TEXT,

    CONSTRAINT "Loadsheet_pkey" PRIMARY KEY ("id")
);
