import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`[${topic}] shop: ${shop}, customerId: ${payload?.customer?.id}`);

  // Anonymize PII fields on any orders belonging to this customer
  const orderIds = (payload?.orders_to_redact || []).map((o) => BigInt(o.id));

  if (orderIds.length > 0) {
    await db.order.updateMany({
      where: { shopifyId: { in: orderIds }, shop },
      data: {
        email: null,
        phone: null,
        customerName: null,
        address: null,
      },
    });
  }

  return new Response(null, { status: 200 });
};
