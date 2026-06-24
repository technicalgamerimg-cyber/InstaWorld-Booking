import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`[${topic}] shop: ${shop}, customerId: ${payload?.customer?.id}`);

  // This app stores order data synced from Shopify (name, email, phone, city, address).
  // Data is available in the Shopify Admin under the customer's order history.
  // No additional data is stored beyond what Shopify already provides to the merchant.

  return new Response(null, { status: 200 });
};
