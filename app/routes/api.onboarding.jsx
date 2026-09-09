import { authenticate } from "../shopify.server";
import db from "../db.server";
import { detectAndSaveAvailableCouriers } from "../utils/couriers.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const apiKey = (f.get("instaworldApiKey") || "").trim();
  if (!apiKey) return { ok: false, error: "InstaWorld API key is required to continue." };

  if (f.get("intent") === "checkCouriers") {
    try {
      const res = await detectAndSaveAvailableCouriers(session.shop, apiKey);
      return {
        ok: true,
        availableCouriers: res.availableCouriers,
        defaultCourier: res.defaultCourier,
      };
    } catch (err) {
      console.error("[onboarding:checkCouriers] failed:", err.message);
      return { ok: false, error: err.message || "Failed to verify API key and couriers." };
    }
  }

  const defaultCourier = f.get("defaultCourier") || "Auto";

  await db.settings.upsert({
    where: { shop: session.shop },
    update: {
      instaworldApiKey: apiKey,
      defaultCourier,
      shipperName: f.get("shipperName") || null,
      shipperPhone: f.get("shipperPhone") || null,
      shipperAddress: f.get("shipperAddress") || null,
      defaultWeight: parseFloat(f.get("defaultWeight")) || 1,
      defaultInstructions: f.get("defaultInstructions") || null,
    },
    create: {
      shop: session.shop,
      instaworldApiKey: apiKey,
      defaultCourier,
      shipperName: f.get("shipperName") || null,
      shipperPhone: f.get("shipperPhone") || null,
      shipperAddress: f.get("shipperAddress") || null,
      defaultWeight: parseFloat(f.get("defaultWeight")) || 1,
      defaultInstructions: f.get("defaultInstructions") || null,
    },
  });

  // Ensure couriers are probed if not yet done
  try {
    const existing = await db.settings.findUnique({ where: { shop: session.shop } });
    if (!existing?.availableCouriers) {
      await detectAndSaveAvailableCouriers(session.shop, apiKey);
    }
  } catch (err) {
    console.warn("[onboarding] auto-courier probe warning:", err.message);
  }

  return { ok: true };
};
