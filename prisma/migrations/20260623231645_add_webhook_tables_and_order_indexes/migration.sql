-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" SERIAL NOT NULL,
    "webhookId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookFailure" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_key" ON "WebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookFailure_shop_createdAt_idx" ON "WebhookFailure"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_processedAt_idx" ON "WebhookEvent"("shop", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shop_createdAt_idx" ON "Order"("shop", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Order_shop_bookingStatus_trackingNumber_idx" ON "Order"("shop", "bookingStatus", "trackingNumber");
