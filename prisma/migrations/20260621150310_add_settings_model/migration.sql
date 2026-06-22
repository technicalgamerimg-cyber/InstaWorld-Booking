-- CreateTable
CREATE TABLE "Settings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "instaworldApiKey" TEXT,
    "defaultWeight" DOUBLE PRECISION DEFAULT 1,
    "defaultInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
