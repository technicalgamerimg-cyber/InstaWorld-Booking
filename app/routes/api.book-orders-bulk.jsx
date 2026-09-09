import pLimit from "p-limit";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureOrderInDb, parseOrderGid } from "../utils/orderSync.server";
import { bookOrderWithLiveSync } from "../utils/booking.server";
import { getCities } from "../utils/cities.server";

// Backend for the "Book with Instant Bulk Booking" bulk-selection admin action
// extension (extensions/instant-book-orders-bulk) on the Orders index page —
// merchants select many orders, review/correct each one's address/phone/city, and
// book them all in one action. Mirrors the bulk "book" intent already in
// app.orders.jsx (same concurrency, same shared bookOrderWithLiveSync engine), just
// reachable from outside the embedded app via authenticate.admin's extension
// bearer-token support, same as api.book-order.jsx. The loader's ensureOrderInDb is
// cache-first (fine for prefill display); the action's bookOrderWithLiveSync always
// re-fetches Shopify live and writes the correction back to the real order — see
// app/utils/orderSync.server.js and app/utils/booking.server.js.

function orderSummary(order) {
  return {
    id: order.shopifyId.toString(),
    name: order.name,
    customerName: order.customerName,
    city: order.city,
    address: order.address,
    phone: order.phone,
    alreadyBooked: order.bookingStatus === "booked" || Boolean(order.trackingNumber),
    trackingNumber: order.trackingNumber,
  };
}

export const loader = async ({ request }) => {
  const { admin, session, cors } = await authenticate.admin(request);

  const shopifyIds = [...new Set(
    new URL(request.url).searchParams.getAll("orderId").map(parseOrderGid).filter(Boolean)
  )];
  if (shopifyIds.length === 0) {
    return cors(Response.json({ ok: false, error: "No orders selected" }, { status: 400 }));
  }

  try {
    const limit = pLimit(5);
    const [orders, settings, cities] = await Promise.all([
      Promise.all(shopifyIds.map((id) => limit(() => ensureOrderInDb({ admin, shop: session.shop, shopifyId: id })))),
      db.settings.findUnique({ where: { shop: session.shop } }),
      getCities(),
    ]);

    return cors(Response.json({
      ok: true,
      orders: orders.filter(Boolean).map(orderSummary),
      cities,
      settings: {
        hasApiKey: Boolean(settings?.instaworldApiKey),
        defaultWeight: settings?.defaultWeight ?? 1,
        defaultInstructions: settings?.defaultInstructions ?? "",
      },
    }));
  } catch (err) {
    console.error("[api.book-orders-bulk] loader failed:", err.message);
    return cors(Response.json({ ok: false, error: "Could not load selected orders." }, { status: 500 }));
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

  // Each item carries its own address/phone/city correction — a one-time override
  // for this shipment only, same as the single-order admin action. Deduped by shopifyId.
  const itemsById = new Map();
  for (const item of Array.isArray(body.items) ? body.items : []) {
    const shopifyId = parseOrderGid(item?.orderId);
    if (shopifyId) itemsById.set(shopifyId.toString(), { shopifyId, address: item.address, phone: item.phone, city: item.city });
  }
  const items = [...itemsById.values()];
  if (items.length === 0) {
    return cors(Response.json({ ok: false, error: "No orders selected" }, { status: 400 }));
  }

  const settings = await db.settings.findUnique({ where: { shop: session.shop } });
  if (!settings?.instaworldApiKey) {
    return cors(Response.json({ ok: false, error: "InstaWorld API key not configured. Go to Settings first." }));
  }

  const weightGrams = body.weight !== undefined && body.weight !== null && body.weight !== ""
    ? parseFloat(body.weight)
    : null;
  const customCod = body.cod !== undefined && body.cod !== null && body.cod !== ""
    ? parseFloat(body.cod)
    : null;

  const bookOne = ({ shopifyId, address, phone, city }) =>
    bookOrderWithLiveSync({
      admin,
      shop: session.shop,
      shopifyId,
      apiKey: settings.instaworldApiKey,
      weightGrams,
      defaultWeightKg: settings.defaultWeight ?? 1,
      customCod,
      instructions: body.instructions || null,
      defaultInstructions: settings.defaultInstructions,
      addressOverride: address,
      phoneOverride: phone,
      cityOverride: city,
    });

  const limit = pLimit(5);
  const results = await Promise.allSettled(items.map((item) => limit(() => bookOne(item))));

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
