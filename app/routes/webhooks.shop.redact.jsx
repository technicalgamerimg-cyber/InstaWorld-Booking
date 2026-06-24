import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`[${topic}] shop: ${shop} — deleting all shop data`);

  // Delete all data stored for this shop (fires 48 days after uninstall)
  await Promise.allSettled([
    db.order.deleteMany({ where: { shop } }),
    db.settings.deleteMany({ where: { shop } }),
    db.loadsheet.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.webhookDelivery.deleteMany({}), // no shop field — clear all (small table)
    db.webhookEvent.deleteMany({ where: { shop } }),
    db.webhookFailure.deleteMany({ where: { shop } }),
  ]);

  return new Response(null, { status: 200 });
};
