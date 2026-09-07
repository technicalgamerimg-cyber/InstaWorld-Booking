import db from "../db.server";
import { createShipment } from "./instaworld.server";
import { graphqlQueryWithRetry, parseGraphQLResponse } from "./graphql.server";

// Books a single order with InstaWorld and creates the matching Shopify fulfillment.
// Shared by the Orders page bulk/single "Book" action and the order-details/order-index
// admin action extensions. addressOverride/phoneOverride/cityOverride let the merchant
// correct the consignee details right before booking without touching the Shopify order
// or our own Order record — a one-time substitution for this shipment's payload only.
// cityOverride should be an exact name from the City table (InstaWorld's own list) —
// the whole point is to stop sending whatever free-text city the Shopify order has,
// since a typo or a non-serviceable city there is the #1 cause of booking failures.
// Falls back to the order's own city only when no override was given.
// Throws on hard failure (e.g. InstaWorld rejected the shipment); Shopify fulfillment
// errors are recorded on the order but do not throw, since InstaWorld is the source of truth.
export async function bookOrderShipment({ admin, order, apiKey, weightKg, codAmount, instructions, addressOverride, phoneOverride, cityOverride }) {
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
    financial_status: order.financialStatus === "paid" ? "paid" : "cod",
    remarks: instructions || "",
    items,
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
      ...(shopifyFulfillmentId ? { shopifyFulfillmentId } : {}),
      ...(shopifyFulfillmentError ? { shopifyFulfillmentError } : {}),
    },
  });

  return { id: order.id, trackingNumber: result.tracking_number };
}

export function defaultCodValue(order) {
  return order.financialStatus === "paid" ? 0 : parseFloat(order.totalPrice || "0");
}
