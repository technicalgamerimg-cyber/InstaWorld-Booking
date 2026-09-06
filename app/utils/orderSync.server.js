import db from "../db.server";
import { graphqlQueryWithRetry } from "./graphql.server";

const ORDER_QUERY = `
  #graphql
  query GetOrderForBooking($id: ID!) {
    order(id: $id) {
      id
      name
      email
      phone
      updatedAt
      totalPriceSet { shopMoney { amount currencyCode } }
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
      shippingAddress { firstName lastName address1 address2 city phone }
    }
  }
`;

// Looks up an order by its Shopify numeric id in our DB; if it isn't there yet
// (webhook hasn't landed, or it's brand new), fetches it live from Shopify and
// creates the row. Used by the order-details admin action, where we can't assume
// the webhook-driven mirror is already populated.
export async function ensureOrderInDb({ admin, shop, shopifyId }) {
  const existing = await db.order.findUnique({ where: { shopifyId } });
  if (existing) return existing;

  const data = await graphqlQueryWithRetry(
    admin,
    ORDER_QUERY,
    { id: `gid://shopify/Order/${shopifyId.toString()}` },
    "GetOrderForBooking",
  );
  const node = data?.order;
  if (!node) return null;

  const customerName =
    [node.shippingAddress?.firstName, node.shippingAddress?.lastName].filter(Boolean).join(" ") ||
    [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null;

  const lineItems = (node.lineItems?.edges ?? []).map(({ node: li }) => ({
    title: li.title ?? "",
    price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0",
    quantity: li.quantity ?? 1,
    sku: li.sku ?? "",
  }));

  return db.order.upsert({
    where: { shopifyId },
    update: {},
    create: {
      shopifyId,
      shop,
      name: node.name ?? "",
      email: node.email ?? null,
      phone: node.phone ?? node.shippingAddress?.phone ?? null,
      totalPrice: node.totalPriceSet?.shopMoney?.amount ?? "0",
      currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "",
      financialStatus: (node.displayFinancialStatus ?? "").toLowerCase(),
      fulfillmentStatus: (node.displayFulfillmentStatus ?? "").toLowerCase(),
      lineItems,
      customerName,
      city: node.shippingAddress?.city ?? null,
      address: [node.shippingAddress?.address1, node.shippingAddress?.address2].filter(Boolean).join(", ") || null,
      shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
      bookingStatus: "pending",
    },
  });
}

export function parseOrderGid(rawId) {
  const idPart = String(rawId).split("/").pop();
  if (!idPart || !/^\d+$/.test(idPart)) return null;
  return BigInt(idPart);
}
