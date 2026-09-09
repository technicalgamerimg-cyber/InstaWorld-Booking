import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "ORDERS_CREATE" || topic === "ORDERS_UPDATED") {
    const o = payload;

    if (!o?.id) {
      console.warn(`[webhook:${topic}] payload missing order id — skipping`);
      return new Response(null, { status: 200 });
    }

    // Deduplication — store webhookId before processing so concurrent retries are blocked
    const webhookId = request.headers.get("X-Shopify-Webhook-Id");
    if (webhookId) {
      const existing = await db.webhookDelivery.findUnique({ where: { webhookId } });
      if (existing) return new Response(null, { status: 200 });
      await db.webhookDelivery.create({ data: { webhookId } });
    }

    // Out-of-order guard — skip stale payloads that arrived after a newer update.
    // Compares against Shopify's own updated_at (shopifyUpdatedAt), not Prisma's
    // @updatedAt, which also gets bumped by unrelated local writes (e.g. booking
    // actions) and would otherwise cause genuinely newer webhooks to be dropped.
    const existingOrder = await db.order.findUnique({
      where: { shopifyId: BigInt(o.id) },
      select: { shopifyUpdatedAt: true },
    });
    if (existingOrder?.shopifyUpdatedAt && new Date(o.updated_at) <= existingOrder.shopifyUpdatedAt) {
      return new Response(null, { status: 200 });
    }

    const customerName =
      [o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(" ") ||
      [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") ||
      null;

    try {
      await db.order.upsert({
        where: { shopifyId: BigInt(o.id) },
        update: {
          shop,
          name: o.name ?? null,
          email: o.email ?? null,
          phone: o.phone || o.shipping_address?.phone || null,
          // current_total_price (present on the REST webhook payload) reflects order
          // edits, unlike total_price which is frozen at creation — see the "outstanding
          // amount" note in orderSync.server.js's mapOrderNode for the full reasoning.
          totalPrice: o.financial_status === "paid" ? "0" : (o.current_total_price ?? o.total_price ?? "0"),
          currency: o.currency ?? "",
          financialStatus: o.financial_status ?? "pending",
          fulfillmentStatus: o.fulfillment_status ?? null,
          lineItems: o.line_items ?? [],
          customerName,
          city: o.shipping_address?.city || null,
          address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
          shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,
        },
        create: {
          shopifyId: BigInt(o.id),
          shop,
          name: o.name ?? null,
          email: o.email ?? null,
          phone: o.phone || o.shipping_address?.phone || null,
          // current_total_price (present on the REST webhook payload) reflects order
          // edits, unlike total_price which is frozen at creation — see the "outstanding
          // amount" note in orderSync.server.js's mapOrderNode for the full reasoning.
          totalPrice: o.financial_status === "paid" ? "0" : (o.current_total_price ?? o.total_price ?? "0"),
          currency: o.currency ?? "",
          financialStatus: o.financial_status ?? "pending",
          fulfillmentStatus: o.fulfillment_status ?? null,
          lineItems: o.line_items ?? [],
          customerName,
          city: o.shipping_address?.city || null,
          shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,
          address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
          bookingStatus: "pending",
        },
      });

      // Success log + TTL cleanup (fire-and-forget, non-blocking)
      db.webhookEvent.create({ data: { shop, topic, shopifyOrderId: String(o.id) } }).catch(() => {});
      db.webhookDelivery.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }).catch(() => {});

    } catch (err) {
      console.error(`[webhook:${topic}] upsert failed — shop: ${shop}, orderId: ${o.id}`, err.message);
      // Persist to dead-letter table for manual replay via /api/webhook-replay
      await db.webhookFailure.create({
        data: { shop, topic, shopifyOrderId: String(o.id), errorMessage: err.message, rawPayload: o },
      }).catch(() => {});
      // Always 200 — a 500 here causes Shopify to retry indefinitely. The dead-letter
      // table above captures the failure for manual replay via /api/webhook-replay.
      return new Response(null, { status: 200 });
    }
  }

  return new Response(null, { status: 200 });
};
