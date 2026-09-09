import db from "../db.server.js";
import { graphqlQueryWithRetry, parseGraphQLResponse } from "./graphql.server.js";

// Shared field set for both the "create if missing" lookup (ensureOrderInDb, used by
// loaders — cheap, cache-first, fine to be a little stale) and the "always live"
// lookup (getFreshOrderForBooking, used at the moment of booking — must never be
// stale). currentTotalPriceSet/totalOutstandingSet and the full shippingAddress are
// only needed by the booking path, but there's no harm requesting them for both.
const ORDER_FIELDS = `
  id
  name
  email
  phone
  updatedAt
  totalPriceSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount currencyCode } }
  displayFinancialStatus
  displayFulfillmentStatus
  lineItems(first: 50) {
    edges {
      node {
        title
        quantity
        originalUnitPriceSet { shopMoney { amount } }
        sku
      }
    }
  }
  customer { firstName lastName }
  shippingAddress {
    firstName lastName address1 address2 city company provinceCode zip countryCodeV2 phone
  }
`;

const ORDER_QUERY = `
  #graphql
  query GetOrderForBooking($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

function orderGid(shopifyId) {
  return `gid://shopify/Order/${shopifyId.toString()}`;
}

function mapOrderNode(node, shop) {
  const customerName =
    [node.shippingAddress?.firstName, node.shippingAddress?.lastName].filter(Boolean).join(" ") ||
    [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null;

  const lineItems = (node.lineItems?.edges ?? []).map(({ node: li }) => ({
    title: li.title ?? "",
    price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0",
    quantity: li.quantity ?? 1,
    sku: li.sku ?? "",
  }));

  return {
    shop,
    name: node.name ?? "",
    email: node.email ?? null,
    phone: node.phone ?? node.shippingAddress?.phone ?? null,
    // Cache the OUTSTANDING amount here, not the original total — totalPrice is what
    // every display surface (Orders table, booking modal reference, Shipments page,
    // loadsheets) reads, and it needs to move when the order is edited. Storing
    // totalPriceSet (original, never changes after creation) meant the display never
    // reflected an edit no matter how many times a webhook fired or "Sync orders" was
    // clicked — only the booking action itself computed the right number, and never
    // wrote it back here. computeOutstandingAmount already returns 0 for paid orders.
    totalPrice: String(computeOutstandingAmount(node)),
    currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "",
    financialStatus: (node.displayFinancialStatus ?? "").toLowerCase(),
    fulfillmentStatus: (node.displayFulfillmentStatus ?? "").toLowerCase(),
    lineItems,
    customerName,
    city: node.shippingAddress?.city ?? null,
    address: [node.shippingAddress?.address1, node.shippingAddress?.address2].filter(Boolean).join(", ") || null,
    shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

// Shopify's totalOutstandingSet already nets out payments received and refunds —
// "the total amount not yet transacted for the order" — so it's the correct default
// COD to collect, not totalPriceSet/currentTotalPriceSet (see investigation notes).
// Clamped at 0: a negative outstanding means Shopify owes the customer a refund,
// which is never a COD amount to collect on delivery.
export function computeOutstandingAmount(node) {
  const raw = parseFloat(node?.totalOutstandingSet?.shopMoney?.amount ?? "0");
  return Number.isNaN(raw) ? 0 : Math.max(0, raw);
}

// Looks up an order by its Shopify numeric id in our DB; if it isn't there yet
// (webhook hasn't landed, or it's brand new), fetches it live from Shopify and
// creates the row. Cache-first — fine for loaders/prefill display, but NOT for
// the moment of booking (see getFreshOrderForBooking for that).
export async function ensureOrderInDb({ admin, shop, shopifyId }) {
  const existing = await db.order.findUnique({ where: { shopifyId } });
  if (existing) return existing;

  const data = await graphqlQueryWithRetry(admin, ORDER_QUERY, { id: orderGid(shopifyId) }, "GetOrderForBooking");
  const node = data?.order;
  if (!node) return null;

  return db.order.upsert({
    where: { shopifyId },
    update: {},
    create: { shopifyId, ...mapOrderNode(node, shop), bookingStatus: "pending" },
  });
}

// The final synchronization gate: always fetches Shopify live (never trusts the DB
// cache), re-syncs the DB row with whatever comes back, and returns both the synced
// row and the raw node (needed for totalOutstandingSet and the full shipping address,
// which the DB row doesn't retain in full). Throws if Shopify can't be reached or the
// order no longer exists — callers must treat that as "stop booking, do not fall back
// to the stale DB amount."
export async function getFreshOrderForBooking({ admin, shop, shopifyId }) {
  const data = await graphqlQueryWithRetry(admin, ORDER_QUERY, { id: orderGid(shopifyId) }, "GetFreshOrderForBooking");
  const node = data?.order;
  if (!node) {
    throw new Error("order not found in Shopify");
  }

  const dbOrder = await db.order.upsert({
    where: { shopifyId },
    update: mapOrderNode(node, shop),
    create: { shopifyId, ...mapOrderNode(node, shop), bookingStatus: "pending" },
  });

  return { dbOrder, node, outstandingAmount: computeOutstandingAmount(node) };
}

// Writes a merchant's address/phone/city correction back to the real Shopify order
// (orderUpdate), not just into the InstaWorld payload. orderUpdate overwrites the
// entire shippingAddress object, so unrelated fields (name, company, province, zip,
// country) are carried over unchanged from currentShippingAddress — only address1,
// city, and phone are replaced when a correction was actually provided.
// Best-effort by design: callers should catch and log, not abort booking on failure.
export async function updateShopifyOrderAddress(admin, shopifyId, currentShippingAddress, { address, phone, city }) {
  const trimmedAddress = (address || "").trim();
  const trimmedPhone = (phone || "").trim();
  const trimmedCity = (city || "").trim();
  if (!trimmedAddress && !trimmedPhone && !trimmedCity) return;

  const current = currentShippingAddress || {};
  const shippingAddress = {
    firstName: current.firstName || null,
    lastName: current.lastName || null,
    company: current.company || null,
    address1: trimmedAddress || current.address1 || null,
    address2: current.address2 || null,
    city: trimmedCity || current.city || null,
    provinceCode: current.provinceCode || null,
    zip: current.zip || null,
    countryCode: current.countryCodeV2 || null,
    phone: trimmedPhone || current.phone || null,
  };

  const mutation = `
    #graphql
    mutation OrderUpdateShippingAddress($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }
  `;
  const res = await admin.graphql(mutation, { variables: { input: { id: orderGid(shopifyId), shippingAddress } } });
  const payload = await res.json();
  parseGraphQLResponse(payload, "orderUpdate", res);
  const errors = payload.data?.orderUpdate?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }
}

export function parseOrderGid(rawId) {
  const idPart = String(rawId).split("/").pop();
  if (!idPart || !/^\d+$/.test(idPart)) return null;
  return BigInt(idPart);
}
