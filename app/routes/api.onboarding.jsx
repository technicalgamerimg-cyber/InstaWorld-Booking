import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const apiKey = (f.get("instaworldApiKey") || "").trim();
  if (!apiKey) return { ok: false, error: "InstaWorld API key is required to continue." };

  await db.settings.upsert({
    where: { shop: session.shop },
    update: {
      instaworldApiKey: apiKey,
      shipperName: f.get("shipperName") || null,
      shipperPhone: f.get("shipperPhone") || null,
      shipperAddress: f.get("shipperAddress") || null,
      defaultWeight: parseFloat(f.get("defaultWeight")) || 1,
      defaultInstructions: f.get("defaultInstructions") || null,
    },
    create: {
      shop: session.shop,
      instaworldApiKey: apiKey,
      shipperName: f.get("shipperName") || null,
      shipperPhone: f.get("shipperPhone") || null,
      shipperAddress: f.get("shipperAddress") || null,
      defaultWeight: parseFloat(f.get("defaultWeight")) || 1,
      defaultInstructions: f.get("defaultInstructions") || null,
    },
  });

  return { ok: true };
};
