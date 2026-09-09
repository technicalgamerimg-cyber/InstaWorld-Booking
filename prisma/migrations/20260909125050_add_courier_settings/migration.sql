-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "availableCouriers" JSONB,
ADD COLUMN     "defaultCourier" TEXT DEFAULT 'Auto';
