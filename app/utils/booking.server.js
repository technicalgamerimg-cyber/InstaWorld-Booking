import db from "../db.server.js";
import { createShipment } from "./instaworld.server.js";
import { graphqlQueryWithRetry, parseGraphQLResponse } from "./graphql.server.js";
import { getFreshOrderForBooking, updateShopifyOrderAddress } from "./orderSync.server.js";

// Final step of the booking pipeline: sends the InstaWorld createShipment payload and
// creates the matching Shopify fulfillment. Call via bookOrderWithLiveSync below rather
// than directly — that's what fetches a live order, computes the authoritative COD, and
// writes any address/phone/city correction back to the real Shopify order; this function
// just takes an already-decided order/amount and executes the booking. addressOverride/
// phoneOverride/cityOverride here only affect the InstaWorld payload itself (the write-
// back to Shopify already happened one level up, in bookOrderWithLiveSync).
// cityOverride should be an exact name from the City table (InstaWorld's own list) —
// the whole point is to stop sending whatever free-text city the Shopify order has,
// since a typo or a non-serviceable city there is the #1 cause of booking failures.
// Falls back to the order's own city only when no override was given.
// Throws on hard failure (e.g. InstaWorld rejected the shipment); Shopify fulfillment
// errors are recorded on the order but do not throw, since InstaWorld is the source of truth.
export async function bookOrderShipment({ admin, order, apiKey, weightKg, codAmount, instructions, addressOverride, phoneOverride, cityOverride, codSource, courier }) {
  const nameParts = (order.customerName || "Customer").split(" ");

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const items = lineItems.length > 0
    ? lineItems.map((item) => ({
        title: item.title || "Item",
        price: parseFloat(item.price) || 0,
        quantity: item.quantity || 1,
        sku: item.sku || "",
        kg: weightKg,
      }))
    : [{ title: "Item", price: parseFloat(order.totalPrice || "0"), quantity: 1, sku: "", kg: weightKg }];

  const address = (addressOverride || "").trim() || order.address || order.city || "";
  const phone = (phoneOverride || "").trim() || order.phone || "";
  const city = (cityOverride || "").trim() || order.city || "";

  const label = order.name || String(order.id);
  if (!address) throw new Error(`${label}: Delivery address is required`);
  if (!phone) throw new Error(`${label}: Phone number is required`);
  if (!city) throw new Error(`${label}: InstaWorld city is required`);

  const payload = {
    api_key: apiKey,
    ref_no: (order.name || String(order.id)).replace("#", ""),
    consignee_first_name: nameParts[0] || "Customer",
    consignee_last_name: nameParts.slice(1).join(" ") || "",
    consignee_email: order.email || "",
    consignee_phone: phone,
    consignee_address: address,
    consignee_city: city,
    amount: codAmount,
    financial_status: codAmount > 0 ? "cod" : "paid",
    remarks: instructions || "",
    items,
    ...(courier && courier !== "Auto" ? { courier } : {}),
  };

  // createShipment has built-in retry (3 attempts) + 30s AbortController timeout
  const res = await createShipment(payload);
  const result = await res.json();

  if (!result.tracking_number) {
    const msg = typeof result.message === "string" ? result.message : JSON.stringify(result);
    throw new Error(`${order.name || order.id}: ${msg}`);
  }

  // Shopify fulfillment (non-fatal — DB is source of truth)
  let shopifyFulfillmentId = null;
  let shopifyFulfillmentError = null;
  let shopifyFulfillmentState = "pending";
  try {
    const orderGid = `gid://shopify/Order/${order.shopifyId.toString()}`;
    const foData = await graphqlQueryWithRetry(admin, `
      #graphql
      query GetFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 10) {
            edges { node { id status } }
          }
        }
      }
    `, { orderId: orderGid }, "GetFulfillmentOrders:book");
    if (!foData?.order) {
      console.warn(`[bookOrderShipment] order ${orderGid} returned null — may not exist in Shopify`);
    }
    const TERMINAL = new Set(["CLOSED", "CANCELLED", "INCOMPLETE"]);
    const allFOs = foData?.order?.fulfillmentOrders?.edges?.map((e) => e.node) ?? [];
    allFOs.forEach((fo) => {
      if (!TERMINAL.has(fo.status) && !["OPEN", "IN_PROGRESS", "SCHEDULED", "ON_HOLD"].includes(fo.status)) {
        console.warn(`[bookOrderShipment] Unexpected FO status "${fo.status}" for order ${order.name}`);
      }
    });
    const openFOs = allFOs.filter((fo) => !TERMINAL.has(fo.status));
    if (openFOs.length > 0) {
      const fulfillMutation = await admin.graphql(`
        #graphql
        mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment { id status }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: openFOs.map((fo) => ({ fulfillmentOrderId: fo.id })),
            trackingInfo: { number: result.tracking_number, company: result.courier || "InstaWorld" },
            notifyCustomer: false,
          },
        },
      });
      const fulfillPayload = await fulfillMutation.json();
      parseGraphQLResponse(fulfillPayload, "fulfillmentCreateV2", fulfillMutation);
      const fulfillment = fulfillPayload.data?.fulfillmentCreateV2?.fulfillment;
      const errors = fulfillPayload.data?.fulfillmentCreateV2?.userErrors ?? [];
      if (fulfillment?.id) {
        shopifyFulfillmentId = fulfillment.id.split("/").pop(); // store numeric portion
        shopifyFulfillmentState = "fulfilled";
        if (errors.length > 0) {
          console.warn(`[Fulfillment create] ${order.name} succeeded with userErrors:`, errors);
        }
      } else {
        shopifyFulfillmentError = errors.map((e) => e.message).join(", ") || "Unknown Shopify fulfillment error";
        shopifyFulfillmentState = "failed";
        console.error(`[Fulfillment create] ${order.name}:`, shopifyFulfillmentError);
      }
    }
  } catch (e) {
    console.error(`[Fulfillment] ${order.name}:`, e.message);
    shopifyFulfillmentError = e.message;
    shopifyFulfillmentState = "failed";
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      bookingStatus: "booked",
      shipmentStatus: "booked",
      trackingNumber: result.tracking_number,
      courierName: result.courier || null,
      shopifyFulfillmentState: shopifyFulfillmentState ?? "pending",
      shopifySyncStatus: shopifyFulfillmentId ? "synced" : "failed",
      lastBookingAmount: codAmount,
      lastBookingAmountSource: codSource ?? null,
      lastBookingSyncAt: new Date(),
      ...(shopifyFulfillmentId ? { shopifyFulfillmentId } : {}),
      ...(shopifyFulfillmentError ? { shopifyFulfillmentError } : {}),
    },
  });

  return { id: order.id, trackingNumber: result.tracking_number };
}

// What to display as the COD figure for an order that's already booked (Shipments
// page, dispatch loadsheets) — must be the amount actually sent to InstaWorld
// (lastBookingAmount), not a recomputation from the DB's plain totalPrice. Those can
// legitimately differ (a merchant COD override, or totalOutstandingSet differing from
// totalPrice at booking time due to a partial payment/refund) — showing totalPrice
// there would tell a rider to collect the wrong amount. Falls back to the pre-fix
// heuristic only for orders booked before lastBookingAmount existed.
export function bookedCodValue(order) {
  if (order.lastBookingAmount !== null && order.lastBookingAmount !== undefined) {
    return order.lastBookingAmount;
  }
  return order.financialStatus === "paid" ? 0 : parseFloat(order.totalPrice || "0");
}

// The single engine all 4 booking gateways (web single/bulk, extension single/bulk)
// must go through — "there should not be four different ways of deciding COD."
//
// Never books using a potentially stale DB amount: always re-fetches the order from
// Shopify live immediately before creating the InstaWorld shipment, uses that fetch's
// totalOutstandingSet as the authoritative default COD (unless the merchant explicitly
// typed an override), re-syncs the DB with whatever Shopify returned, and writes any
// address/phone/city correction back to the real Shopify order (best-effort — this
// step never blocks the booking itself). If Shopify can't be reached or the order no
// longer exists, this throws rather than falling back to cached data — the caller's
// existing per-order failure handling (Promise.allSettled) surfaces that as a normal
// booking failure ("please retry"), leaving the rest of a batch unaffected.
export async function bookOrderWithLiveSync({
  admin, shop, shopifyId, apiKey, weightGrams, defaultWeightKg,
  customCod, instructions, defaultInstructions,
  addressOverride, phoneOverride, cityOverride,
  courier,
}) {
  // Cheap pre-check so an already-booked order doesn't waste a live Shopify call.
  const existing = await db.order.findUnique({
    where: { shopifyId },
    select: { id: true, bookingStatus: true, trackingNumber: true },
  });
  if (existing && (existing.bookingStatus === "booked" || existing.trackingNumber)) {
    return { id: existing.id, skipped: true };
  }

  // Validate courier against store's configured availableCouriers
  const settings = await db.settings.findUnique({
    where: { shop },
    select: { availableCouriers: true, defaultCourier: true },
  });
  const availableCouriers = Array.isArray(settings?.availableCouriers) ? settings.availableCouriers : [];

  let finalCourier = courier;
  if (finalCourier && finalCourier !== "Auto") {
    if (!availableCouriers.includes(finalCourier)) {
      throw new Error(`Courier "${finalCourier}" is not available for this store.`);
    }
  } else if (!finalCourier) {
    // Fallback to store default if no courier was passed
    if (settings?.defaultCourier && settings.defaultCourier !== "Auto" && availableCouriers.includes(settings.defaultCourier)) {
      finalCourier = settings.defaultCourier;
    } else {
      finalCourier = "Auto";
    }
  }

  let fresh;
  try {
    fresh = await getFreshOrderForBooking({ admin, shop, shopifyId });
  } catch (err) {
    throw new Error(`Unable to verify latest Shopify order (order ${shopifyId}): ${err.message}. Please retry.`);
  }

  const { dbOrder, node, outstandingAmount } = fresh;

  // Re-check post-sync — another concurrent booking could have completed between the
  // pre-check above and this fetch resolving.
  if (dbOrder.bookingStatus === "booked" || dbOrder.trackingNumber) {
    return { id: dbOrder.id, skipped: true };
  }

  const weightKg = weightGrams !== null && !Number.isNaN(weightGrams) ? weightGrams / 1000 : defaultWeightKg;
  const hasOverride = customCod !== null && !Number.isNaN(customCod);
  const codAmount = hasOverride ? customCod : outstandingAmount;
  const codSource = hasOverride ? "override" : "shopify_outstanding";

  try {
    await updateShopifyOrderAddress(admin, shopifyId, node.shippingAddress, {
      address: addressOverride,
      phone: phoneOverride,
      city: cityOverride,
    });
  } catch (err) {
    console.error(`[bookOrderWithLiveSync] Shopify address write-back failed for ${dbOrder.name}:`, err.message);
  }

  return bookOrderShipment({
    admin,
    order: dbOrder,
    apiKey,
    weightKg,
    codAmount,
    codSource,
    instructions: instructions ?? defaultInstructions ?? "",
    addressOverride,
    phoneOverride,
    cityOverride,
    courier: finalCourier,
  });
}
