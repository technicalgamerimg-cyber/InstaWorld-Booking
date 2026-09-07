import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureOrderInDb, parseOrderGid } from "../utils/orderSync.server";
import { bookOrderShipment, defaultCodValue } from "../utils/booking.server";
import { getCities } from "../utils/cities.server";

// Backend for the "Book with Instant Bulk Booking" admin action extension
// (extensions/instant-book-order) — the extension only renders UI, all Shopify/DB/
// InstaWorld access happens here. authenticate.admin(request) validates the
// extension's session token (sent as an Authorization bearer header) exactly like
// it validates the embedded app's own fetches; `cors` must wrap every response
// since the extension runs on a different origin than this app.

function orderSummary(order) {
  return {
    id: order.id,
    name: order.name,
    customerName: order.customerName,
    city: order.city,
    address: order.address,
    phone: order.phone,
    currency: order.currency,
    financialStatus: order.financialStatus,
    totalPrice: order.totalPrice,
    trackingNumber: order.trackingNumber,
  };
}

export const loader = async ({ request }) => {
  const { admin, session, cors } = await authenticate.admin(request);

  const shopifyId = parseOrderGid(new URL(request.url).searchParams.get("orderId"));
  if (!shopifyId) {
    return cors(Response.json({ ok: false, error: "Missing or invalid orderId" }, { status: 400 }));
  }

  try {
    const [order, settings, cities] = await Promise.all([
      ensureOrderInDb({ admin, shop: session.shop, shopifyId }),
      db.settings.findUnique({ where: { shop: session.shop } }),
      getCities(),
    ]);

    if (!order) {
      return cors(Response.json({ ok: false, error: "Order not found in Shopify." }, { status: 404 }));
    }

    return cors(Response.json({
      ok: true,
      order: orderSummary(order),
      alreadyBooked: order.bookingStatus === "booked" || Boolean(order.trackingNumber),
      cities,
      settings: {
        hasApiKey: Boolean(settings?.instaworldApiKey),
        defaultWeight: settings?.defaultWeight ?? 1,
        defaultInstructions: settings?.defaultInstructions ?? "",
      },
    }));
  } catch (err) {
    console.error("[api.book-order] loader failed:", err.message);
    return cors(Response.json({ ok: false, error: "Could not load order." }, { status: 500 }));
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

  const shopifyId = parseOrderGid(body.orderId);
  if (!shopifyId) {
    return cors(Response.json({ ok: false, error: "Missing or invalid orderId" }, { status: 400 }));
  }

  const settings = await db.settings.findUnique({ where: { shop: session.shop } });
  if (!settings?.instaworldApiKey) {
    return cors(Response.json({ ok: false, error: "InstaWorld API key not configured. Go to Settings first." }));
  }

  try {
    const order = await ensureOrderInDb({ admin, shop: session.shop, shopifyId });
    if (!order) {
      return cors(Response.json({ ok: false, error: "Order not found in Shopify." }, { status: 404 }));
    }
    if (order.bookingStatus === "booked" || order.trackingNumber) {
      return cors(Response.json({
        ok: false,
        error: "This order is already booked.",
        trackingNumber: order.trackingNumber,
      }));
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
    const codAmount = customCod !== null && !Number.isNaN(customCod) ? customCod : defaultCodValue(order);

    const instructions = body.instructions || settings.defaultInstructions || "";

    const result = await bookOrderShipment({
      admin,
      order,
      apiKey: settings.instaworldApiKey,
      weightKg,
      codAmount,
      instructions,
      addressOverride: body.address,
      phoneOverride: body.phone,
      cityOverride: body.city,
    });

    return cors(Response.json({ ok: true, trackingNumber: result.trackingNumber }));
  } catch (err) {
    console.error("[api.book-order] action failed:", err.message);
    return cors(Response.json({ ok: false, error: err.message || "Booking failed." }));
  }
};
