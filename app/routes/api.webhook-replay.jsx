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

  try {
    await db.order.upsert({
      where: { shopifyId: BigInt(o.id) },
      update: {
        shop: failure.shop,
        name: o.name,
        email: o.email,
        phone: o.phone || o.shipping_address?.phone || null,
        totalPrice: o.total_price,
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        lineItems: o.line_items,
        customerName,
        city: o.shipping_address?.city || null,
        address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
      },
      create: {
        shopifyId: BigInt(o.id),
        shop: failure.shop,
        name: o.name,
        email: o.email,
        phone: o.phone || o.shipping_address?.phone || null,
        totalPrice: o.total_price,
        currency: o.currency,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        lineItems: o.line_items,
        customerName,
        city: o.shipping_address?.city || null,
        address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
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
