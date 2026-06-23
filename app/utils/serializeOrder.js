export const serializeOrder = (order) => ({
  ...order,
  shopifyId: order.shopifyId.toString(),
  createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
});
