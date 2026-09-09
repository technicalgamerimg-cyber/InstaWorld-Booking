import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { failureId } = await request.json();

  const failure = await db.webhookFailure.findFirst({
    where: { id: Number(failureId), shop: session.shop },
  });
  if (!failure) return { ok: false, error: "Failure record not found" };

  const o = failure.rawPayload;
  const customerName =
    [o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(" ") ||
    [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") ||
    null;

  // Same out-of-order guard as api.webhooks.jsx — if a newer update already landed
  // (e.g. a later webhook succeeded after this one failed), replaying this stale
  // payload would regress the order back to older data. Drop the dead-letter row
  // instead of applying it.
  const existingOrder = await db.order.findUnique({
    where: { shopifyId: BigInt(o.id) },
    select: { shopifyUpdatedAt: true },
  });
  if (existingOrder?.shopifyUpdatedAt && o.updated_at && new Date(o.updated_at) <= existingOrder.shopifyUpdatedAt) {
    await db.webhookFailure.delete({ where: { id: failure.id } });
    return { ok: true, skipped: "superseded" };
  }

  try {
    await db.order.upsert({
      where: { shopifyId: BigInt(o.id) },
      update: {
        shop: failure.shop,
        name: o.name,
        email: o.email,
        phone: o.phone || o.shipping_address?.phone || null,
        // Same fix as api.webhooks.jsx — current_total_price reflects order edits,
        // total_price is frozen at creation.
        totalPrice: o.financial_status === "paid" ? "0" : (o.current_total_price ?? o.total_price ?? "0"),
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        lineItems: o.line_items,
        customerName,
        city: o.shipping_address?.city || null,
        address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
        shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,
      },
      create: {
        shopifyId: BigInt(o.id),
        shop: failure.shop,
        name: o.name,
        email: o.email,
        phone: o.phone || o.shipping_address?.phone || null,
        // Same fix as api.webhooks.jsx — current_total_price reflects order edits,
        // total_price is frozen at creation.
        totalPrice: o.financial_status === "paid" ? "0" : (o.current_total_price ?? o.total_price ?? "0"),
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        lineItems: o.line_items,
        customerName,
        city: o.shipping_address?.city || null,
        address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
        shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,
        bookingStatus: "pending",
      },
    });
    await db.webhookFailure.delete({ where: { id: failure.id } });
    return { ok: true };
  } catch (err) {
    console.error(`[webhook-replay] failed — id: ${failure.id}, orderId: ${o.id}`, err.message);
    return { ok: false, error: err.message };
  }
};
