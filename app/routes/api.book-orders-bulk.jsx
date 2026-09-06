import pLimit from "p-limit";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureOrderInDb, parseOrderGid } from "../utils/orderSync.server";
import { bookOrderShipment, defaultCodValue } from "../utils/booking.server";

// Backend for the "Book with Instant Bulk Booking" bulk-selection admin action
// extension (extensions/instant-book-orders-bulk) on the Orders index page —
// merchants select many orders and book them all in one action. Mirrors the bulk
// "book" intent already in app.orders.jsx (same concurrency, same shared
// bookOrderShipment/ensureOrderInDb utils), just reachable from outside the embedded
// app via authenticate.admin's extension bearer-token support, same as api.book-order.jsx.

export const loader = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);

  try {
    const settings = await db.settings.findUnique({ where: { shop: session.shop } });
    return cors(Response.json({
      ok: true,
      settings: {
        hasApiKey: Boolean(settings?.instaworldApiKey),
        defaultWeight: settings?.defaultWeight ?? 1,
        defaultInstructions: settings?.defaultInstructions ?? "",
      },
    }));
  } catch (err) {
    console.error("[api.book-orders-bulk] loader failed:", err.message);
    return cors(Response.json({ ok: false, error: "Could not load settings." }, { status: 500 }));
  }
};

export const action = async ({ request }) => {
  const { admin, session, cors } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return cors(Response.json({ ok: false, error: "Invalid request body" }, { status: 400 }));
  }

  const shopifyIds = [...new Set(
    (Array.isArray(body.orderIds) ? body.orderIds : []).map(parseOrderGid).filter(Boolean)
  )];
  if (shopifyIds.length === 0) {
    return cors(Response.json({ ok: false, error: "No orders selected" }, { status: 400 }));
  }

  const settings = await db.settings.findUnique({ where: { shop: session.shop } });
  if (!settings?.instaworldApiKey) {
    return cors(Response.json({ ok: false, error: "InstaWorld API key not configured. Go to Settings first." }));
  }

  const weightGrams = body.weight !== undefined && body.weight !== null && body.weight !== ""
    ? parseFloat(body.weight)
    : null;
  const weightKg = weightGrams !== null && !Number.isNaN(weightGrams)
    ? weightGrams / 1000
    : (settings.defaultWeight ?? 1);

  const customCod = body.cod !== undefined && body.cod !== null && body.cod !== ""
    ? parseFloat(body.cod)
    : null;

  const instructions = body.instructions || settings.defaultInstructions || "";

  const bookOne = async (shopifyId) => {
    const order = await ensureOrderInDb({ admin, shop: session.shop, shopifyId });
    if (!order || order.bookingStatus === "booked" || order.trackingNumber) {
      return { skipped: true };
    }

    const codAmount = customCod !== null && !Number.isNaN(customCod) ? customCod : defaultCodValue(order);

    return bookOrderShipment({
      admin,
      order,
      apiKey: settings.instaworldApiKey,
      weightKg,
      codAmount,
      instructions,
    });
  };

  const limit = pLimit(5);
  const results = await Promise.allSettled(shopifyIds.map((id) => limit(() => bookOne(id))));

  const succeeded = results.filter((r) => r.status === "fulfilled" && !r.value?.skipped).length;
  const skipped = results.filter((r) => r.status === "fulfilled" && r.value?.skipped).length;
  const failures = results
    .filter((r) => r.status === "rejected")
    .map((r) => ({ reason: r.reason?.message || String(r.reason) }));

  return cors(Response.json({
    ok: failures.length === 0,
    succeeded,
    skipped,
    failed: failures.length,
    failures,
  }));
};
