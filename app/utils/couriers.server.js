import db from "../db.server.js";
import { createShipment, cancelShipment } from "./instaworld.server.js";

export const CANDIDATE_COURIERS = [
  "TCS",
  "Leopards",
  "Call Courier",
  "M&P",
  "PostEx",
  "Trax",
];

// In-memory set to prevent duplicate detection runs for the same shop concurrently
const activeProbesByShop = new Set();

/**
 * Probes a single courier by sending a minimal test shipment.
 * If 201 Created is returned, it immediately cancels the test tracking number
 * and registers the courier as available.
 */
async function probeSingleCourier(apiKey, courier) {
  const probeRef = `CHK_${Date.now().toString().slice(-6)}`;
  const payload = {
    api_key: apiKey,
    ref_no: probeRef,
    consignee_first_name: "Courier",
    consignee_last_name: "Probe",
    consignee_email: "probe@instaworld.test",
    consignee_phone: "+923001234567",
    consignee_address: "Probe Address Verification",
    consignee_city: "RAWALPINDI",
    amount: 10,
    financial_status: "cod",
    items: [{ title: "Probe Item", price: "10", quantity: 1, sku: "", kg: 0.5 }],
    courier,
  };

  try {
    const res = await createShipment(payload);
    const data = await res.json();

    if (res.status === 201 && data.tracking_number) {
      const trackingNumber = data.tracking_number;
      // Immediately cancel the test shipment
      try {
        const cancelRes = await cancelShipment(trackingNumber, apiKey);
        const cancelData = await cancelRes.json();
        if (cancelRes.status !== 200 || cancelData.status === false) {
          console.error(`[courier-probe] Cancellation warning for ${courier} CN ${trackingNumber}:`, cancelData);
        } else {
          console.log(`[courier-probe] Successfully cancelled test probe for ${courier} (${trackingNumber})`);
        }
      } catch (cancelErr) {
        console.error(`[courier-probe] Critical: Failed to cancel test shipment ${trackingNumber} for ${courier}:`, cancelErr.message);
      }
      return { courier, available: true };
    }

    const reason = data.message || (Array.isArray(data.courier) ? data.courier[0] : "Unavailable");
    return { courier, available: false, reason };
  } catch (err) {
    console.warn(`[courier-probe] Probe failed for courier ${courier}:`, err.message);
    return { courier, available: false, reason: err.message };
  }
}

/**
 * Detects available couriers for a shop's InstaWorld API key, updates the DB,
 * and resets defaultCourier to "Auto" if the previously chosen default is no longer active.
 */
export async function detectAndSaveAvailableCouriers(shop, apiKey) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error("InstaWorld API key is required to check couriers.");
  }

  if (activeProbesByShop.has(shop)) {
    // Wait briefly or return existing DB settings to avoid race condition
    const settings = await db.settings.findUnique({ where: { shop } });
    return {
      availableCouriers: Array.isArray(settings?.availableCouriers) ? settings.availableCouriers : [],
      defaultCourier: settings?.defaultCourier || "Auto",
      alreadyRunning: true,
    };
  }

  activeProbesByShop.add(shop);
  try {
    const results = [];
    for (const courier of CANDIDATE_COURIERS) {
      const res = await probeSingleCourier(apiKey.trim(), courier);
      results.push(res);
    }

    const availableCouriers = results.filter((r) => r.available).map((r) => r.courier);

    // Check existing defaultCourier
    const existing = await db.settings.findUnique({ where: { shop } });
    let newDefaultCourier = existing?.defaultCourier || "Auto";
    if (newDefaultCourier !== "Auto" && !availableCouriers.includes(newDefaultCourier)) {
      newDefaultCourier = "Auto";
    }

    await db.settings.upsert({
      where: { shop },
      update: {
        availableCouriers,
        defaultCourier: newDefaultCourier,
      },
      create: {
        shop,
        instaworldApiKey: apiKey.trim(),
        availableCouriers,
        defaultCourier: newDefaultCourier,
      },
    });

    return {
      availableCouriers,
      defaultCourier: newDefaultCourier,
      results,
    };
  } finally {
    activeProbesByShop.delete(shop);
  }
}

/**
 * Helper to validate whether a chosen courier is valid for a given shop.
 * "Auto" is always valid. Specific couriers must exist in settings.availableCouriers.
 */
export function validateSelectedCourier(courier, availableCouriers) {
  if (!courier || courier === "Auto") {
    return { valid: true, courier: null }; // null means Auto / omit courier
  }
  const allowed = Array.isArray(availableCouriers) ? availableCouriers : [];
  if (allowed.includes(courier)) {
    return { valid: true, courier };
  }
  return {
    valid: false,
    error: `Selected courier "${courier}" is not connected or available for this account. Available couriers: ${allowed.join(", ") || "None (Auto only)"}`,
  };
}
