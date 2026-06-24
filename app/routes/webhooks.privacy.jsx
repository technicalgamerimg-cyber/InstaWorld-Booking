import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  let topic, shop;
  try {
    ({ topic, shop } = await authenticate.webhook(request));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[privacy webhook] auth failed:", error?.message);
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`[privacy] ${topic} — shop: ${shop}`);

  return new Response(null, { status: 200 });
};
