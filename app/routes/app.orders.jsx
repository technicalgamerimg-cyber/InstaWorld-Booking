import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import pLimit from "p-limit";
import { createShipment } from "../utils/instaworld.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Orders page is now a pure DB read — Shopify sync happens via webhooks (api.webhooks.jsx)
  const [orders, shopSettings] = await Promise.all([
    db.order.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        shopifyId: true,
        name: true,
        customerName: true,
        phone: true,
        city: true,
        totalPrice: true,
        currency: true,
        financialStatus: true,
        bookingStatus: true,
        trackingNumber: true,
        createdAt: true,
      },
    }),
    db.settings.findUnique({ where: { shop: session.shop } }),
  ]);

  return {
    orders: orders.map((o) => ({
      ...o,
      shopifyId: o.shopifyId.toString(),
      createdAt: o.createdAt.toISOString(),
    })),
    settings: {
      defaultWeight: shopSettings?.defaultWeight ?? 1,
      defaultInstructions: shopSettings?.defaultInstructions ?? "",
    },
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // Manual admin-triggered sync — the only path that calls the Shopify API on demand
  if (intent === "syncOrders") {
    const response = await admin.graphql(`
      #graphql
      query SyncOrders {
        # intentional limit — matches prior REST limit=50; cursor pagination is a future improvement
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              email
              phone
              totalPriceSet { shopMoney { amount currencyCode } }
              financialStatus
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
        }
      }
    `);
    const payload = await response.json();
    if (payload.extensions?.cost) {
      console.log("[syncOrders] GraphQL cost:", JSON.stringify(payload.extensions.cost));
    }
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((e) => e.message).join(", "));
    }
    const shopifyOrders = payload.data?.orders?.edges?.map(({ node }) => node) ?? [];
    let synced = 0;
    for (const node of shopifyOrders) {
      let numericId;
      try {
        const idPart = node.id?.split("/").pop();
        if (!idPart) { console.warn("[syncOrders] Skipping node with missing id:", node); continue; }
        numericId = BigInt(idPart);
      } catch (e) {
        console.warn("[syncOrders] Skipping malformed GID:", node.id, e.message);
        continue;
      }
      const customerName =
        [node.shippingAddress?.firstName, node.shippingAddress?.lastName].filter(Boolean).join(" ") ||
        [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null;
      const lineItems = node.lineItems.edges.map(({ node: li }) => ({
        title: li.title,
        price: li.originalUnitPriceSet.shopMoney.amount,
        quantity: li.quantity,
        sku: li.sku || "",
      }));
      const orderFields = {
        shop: session.shop,
        name: node.name,
        email: node.email,
        phone: node.phone || node.shippingAddress?.phone || null,
        totalPrice: node.totalPriceSet.shopMoney.amount,
        currency: node.totalPriceSet.shopMoney.currencyCode,
        financialStatus: (node.financialStatus || "").toLowerCase(),
        fulfillmentStatus: (node.displayFulfillmentStatus || "").toLowerCase(),
        lineItems,
        customerName,
        city: node.shippingAddress?.city || null,
        address: [node.shippingAddress?.address1, node.shippingAddress?.address2].filter(Boolean).join(", ") || null,
      };
      await db.order.upsert({
        where: { shopifyId: numericId },
        update: orderFields,
        create: { shopifyId: numericId, ...orderFields, bookingStatus: "pending" },
      });
      synced++;
    }
    return { ok: true, synced };
  }

  if (intent === "book") {
    const ids = JSON.parse(form.get("orderIds"));
    const weightGrams = form.get("weight") ? parseFloat(form.get("weight")) : null;
    const customCod = form.get("cod") !== null && form.get("cod") !== "" ? parseFloat(form.get("cod")) : null;
    const instructions = form.get("instructions") || null;

    const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
    // admin is captured from the outer destructure and available to bookOne via closure
    if (!shopSettings?.instaworldApiKey) {
      return { ok: false, failures: [{ reason: "InstaWorld API key not configured. Go to Settings first." }], succeeded: 0, failed: 1 };
    }

    const apiKey = shopSettings.instaworldApiKey;
    const defaultWeightKg = shopSettings.defaultWeight ?? 1;
    const weightKg = weightGrams !== null ? weightGrams / 1000 : defaultWeightKg;

    const dbOrders = await db.order.findMany({
      where: { id: { in: ids.map(Number) }, shop: session.shop },
      select: {
        id: true, shopifyId: true, name: true, customerName: true, email: true,
        phone: true, address: true, city: true, totalPrice: true, financialStatus: true,
        lineItems: true, bookingStatus: true, trackingNumber: true,
      },
    });

    const bookOne = async (order) => {
      if (order.bookingStatus === "booked" || order.trackingNumber) {
        return { id: order.id, skipped: true };
      }

      const nameParts = (order.customerName || "Customer").split(" ");
      const codAmount = customCod !== null
        ? customCod
        : (order.financialStatus === "paid" ? 0 : parseFloat(order.totalPrice || "0"));

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

      const payload = {
        api_key: apiKey,
        ref_no: (order.name || String(order.id)).replace("#", ""),
        consignee_first_name: nameParts[0] || "Customer",
        consignee_last_name: nameParts.slice(1).join(" ") || "",
        consignee_email: order.email || "",
        consignee_phone: order.phone || "",
        consignee_address: order.address || order.city || "",
        consignee_city: order.city || "",
        amount: codAmount,
        financial_status: order.financialStatus === "paid" ? "paid" : "cod",
        remarks: instructions ?? shopSettings.defaultInstructions ?? "",
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
        const foResponse = await admin.graphql(`
          #graphql
          query GetFulfillmentOrders($orderId: ID!) {
            order(id: $orderId) {
              fulfillmentOrders(first: 10) {
                edges { node { id status } }
              }
            }
          }
        `, { variables: { orderId: orderGid } });
        const foPayload = await foResponse.json();
        if (foPayload.errors?.length) {
          throw new Error(foPayload.errors.map((e) => e.message).join(", "));
        }
        if (!foPayload.data?.order) {
          console.warn(`[bookOne] order ${orderGid} returned null — may not exist in Shopify`);
        }
        const TERMINAL = new Set(["CLOSED", "CANCELLED", "INCOMPLETE"]);
        const allFOs = foPayload.data?.order?.fulfillmentOrders?.edges?.map((e) => e.node) ?? [];
        allFOs.forEach((fo) => {
          if (!TERMINAL.has(fo.status) && !["OPEN", "IN_PROGRESS", "SCHEDULED", "ON_HOLD"].includes(fo.status)) {
            console.warn(`[bookOne] Unexpected FO status "${fo.status}" for order ${order.name}`);
          }
        });
        const openFOs = allFOs.filter((fo) => !TERMINAL.has(fo.status));
        if (openFOs.length > 0) {
          const fulfillMutation = await admin.graphql(`
            #graphql
            mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
              fulfillmentCreateV2(fulfillment: $fulfillment) {
                fulfillment { id status }
                userErrors { field message code }
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
    };

    const limit = pLimit(5);
    const results = await Promise.allSettled(dbOrders.map((order) => limit(() => bookOne(order))));

    const succeeded = results.filter((r) => r.status === "fulfilled" && !r.value?.skipped).length;
    const skipped = results.filter((r) => r.status === "fulfilled" && r.value?.skipped).length;
    const failures = results
      .filter((r) => r.status === "rejected")
      .map((r) => ({ reason: r.reason?.message || String(r.reason) }));

    return { ok: failures.length === 0, succeeded, skipped, failed: failures.length, failures };
  }

  return { ok: true };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function codValue(order) {
  return order.financialStatus === "paid" ? "0" : (order.totalPrice || "0");
}

const S = {
  page: {
    padding: "20px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    color: "#202223",
    background: "#f6f6f7",
    minHeight: "100vh",
  },
  card: {
    background: "#fff",
    borderRadius: "8px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    overflow: "hidden",
  },
  searchWrap: {
    padding: "12px 16px",
    borderBottom: "1px solid #e1e3e5",
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  searchLabel: { fontWeight: "600", whiteSpace: "nowrap" },
  searchInput: {
    flex: 1,
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    padding: "6px 10px",
    fontSize: "14px",
    outline: "none",
  },
  searchBtn: {
    padding: "6px 16px",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    background: "#fff",
    cursor: "pointer",
    fontWeight: "500",
  },
  bulkBar: {
    padding: "8px 16px",
    borderBottom: "1px solid #e1e3e5",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    background: "#fafafa",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "10px 12px",
    textAlign: "left",
    fontWeight: "600",
    color: "#6d7175",
    fontSize: "12px",
    borderBottom: "1px solid #e1e3e5",
    background: "#f6f6f7",
    whiteSpace: "nowrap",
  },
  td: { padding: "10px 12px", borderBottom: "1px solid #f1f1f1", verticalAlign: "middle" },
  btnBook: {
    padding: "5px 14px",
    background: "#202223",
    color: "#fff",
    border: "none",
    borderRadius: "5px",
    cursor: "pointer",
    fontWeight: "500",
    fontSize: "13px",
    marginRight: "6px",
  },
  btnBookDisabled: {
    padding: "5px 14px",
    background: "#c9cccf",
    color: "#fff",
    border: "none",
    borderRadius: "5px",
    cursor: "not-allowed",
    fontWeight: "500",
    fontSize: "13px",
    marginRight: "6px",
  },
  btnOptions: {
    padding: "5px 10px",
    background: "#fff",
    color: "#202223",
    border: "1px solid #c9cccf",
    borderRadius: "5px",
    cursor: "pointer",
    fontSize: "13px",
  },
  btnBulkBook: {
    padding: "6px 16px",
    background: "#202223",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "13px",
  },
  btnCancel: {
    padding: "5px 14px",
    background: "#fff",
    color: "#d82c0d",
    border: "1px solid #d82c0d",
    borderRadius: "5px",
    cursor: "pointer",
    fontWeight: "500",
    fontSize: "13px",
  },
  errorBanner: {
    padding: "10px 16px",
    background: "#fff4f4",
    color: "#d82c0d",
    borderBottom: "1px solid #ffc9c9",
    fontSize: "13px",
  },
};

function PaidBadge() {
  return (
    <span style={{ background: "#d4edda", color: "#155724", padding: "2px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "500" }}>
      Paid
    </span>
  );
}

function StatusBadge({ status, trackingNumber }) {
  const booked = status === "booked";
  return (
    <div>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "500", background: booked ? "#d4edda" : "#fff3cd", color: booked ? "#155724" : "#856404" }}>
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: booked ? "#28a745" : "#ffc107", display: "inline-block" }} />
        {booked ? "Booked" : "Not booked"}
      </span>
      {booked && trackingNumber && (
        <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "3px", fontFamily: "monospace" }}>
          {trackingNumber}
        </div>
      )}
    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function BookingModal({ order, settings, onClose, onConfirm }) {
  const cod = codValue(order);
  const defaultWeightGrams = String(Math.round((settings?.defaultWeight || 1) * 1000));
  const [form, setForm] = useState({
    weight: defaultWeightGrams,
    pieces: "1",
    cod,
    instructions: settings?.defaultInstructions || "",
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: "10px", width: "500px", maxWidth: "95vw", boxShadow: "0 8px 32px rgba(0,0,0,0.2)", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "18px 20px 12px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: "700", fontSize: "16px" }}>
              🛵 Custom booking — {order.name || `#${order.shopifyId}`}
            </div>
            <div style={{ color: "#6d7175", fontSize: "13px", marginTop: "3px" }}>
              {[order.customerName, order.city, `COD ${cod} ${order.currency || "PKR"}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#6d7175", lineHeight: 1 }}>✕</button>
        </div>
        {/* Body */}
        <div style={{ padding: "18px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "14px" }}>
            {[
              { label: "Weight (grams)", key: "weight" },
              { label: "Pieces", key: "pieces" },
              { label: "COD amount (PKR)", key: "cod" },
            ].map(({ label, key }) => (
              <div key={key}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>{label}</label>
                <input
                  type="number"
                  value={form[key]}
                  onChange={set(key)}
                  style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
                />
              </div>
            ))}
          </div>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>Special instructions</label>
            <textarea
              value={form.instructions}
              onChange={set("instructions")}
              rows={3}
              style={{ width: "100%", border: "1px solid #5c6ac4", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", resize: "vertical", boxSizing: "border-box", outline: "none" }}
            />
          </div>
        </div>
        {/* Footer */}
        <div style={{ padding: "12px 20px 18px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button onClick={onClose} style={{ padding: "8px 20px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(form)} style={{ padding: "8px 20px", background: "#202223", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>
            Confirm booking
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { orders, settings } = useLoaderData();
  const fetcher = useFetcher();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [modalOrder, setModalOrder] = useState(null);
  const [submittingId, setSubmittingId] = useState(null);
  const prevState = useRef("idle");

  useEffect(() => {
    if (prevState.current !== "idle" && fetcher.state === "idle") {
      if (fetcher.data?.ok) setSelected(new Set());
      setSubmittingId(null);
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  const filtered = orders.filter((o) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (o.name || "").toLowerCase().includes(q) ||
      (o.customerName || "").toLowerCase().includes(q)
    );
  });

  const bookableFiltered = filtered.filter((o) => o.bookingStatus !== "booked");
  const allSelected = bookableFiltered.length > 0 && bookableFiltered.every((o) => selected.has(o.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bookableFiltered.map((o) => o.id)));
    }
  };

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const submitBook = (ids, rowId = null) => {
    if (rowId !== null) setSubmittingId(rowId);
    fetcher.submit(
      { intent: "book", orderIds: JSON.stringify(ids) },
      { method: "POST" }
    );
  };

  const handleConfirmModal = (form) => {
    setSubmittingId(modalOrder.id);
    fetcher.submit(
      {
        intent: "book",
        orderIds: JSON.stringify([modalOrder.id]),
        weight: form.weight,
        pieces: form.pieces,
        cod: form.cod,
        instructions: form.instructions,
      },
      { method: "POST" }
    );
    setModalOrder(null);
  };

  const isSubmitting = fetcher.state !== "idle";

  return (
    <div style={S.page}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={S.card}>
        {/* Search */}
        <div style={S.searchWrap}>
          <span style={S.searchLabel}>Search orders</span>
          <input
            style={S.searchInput}
            placeholder="Order number, customer name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            style={{ ...S.searchBtn, marginLeft: "auto" }}
            disabled={isSubmitting}
            onClick={() => fetcher.submit({ intent: "syncOrders" }, { method: "POST" })}
          >
            {fetcher.data?.synced !== undefined && fetcher.state === "idle" ? `Synced ${fetcher.data.synced}` : "Sync orders"}
          </button>
        </div>

        {/* Error banner */}
        {fetcher.data?.failures?.length > 0 && (
          <div style={S.errorBanner}>
            <div>
              ⚠ {fetcher.data.failed} order{fetcher.data.failed !== 1 ? "s" : ""} failed to book
              {fetcher.data.succeeded > 0 ? ` (${fetcher.data.succeeded} succeeded)` : ""}:
            </div>
            <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
              {fetcher.data.failures.map((f, i) => <li key={i}>{f.reason}</li>)}
            </ul>
          </div>
        )}

        {/* Bulk bar */}
        <div style={S.bulkBar}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            style={{ width: "15px", height: "15px", cursor: "pointer" }}
          />
          <span style={{ color: "#6d7175", fontSize: "13px" }}>
            {selected.size > 0 ? `${selected.size} selected` : "Select all"}
          </span>
          {selected.size > 0 && (
            <button
              style={S.btnBulkBook}
              disabled={isSubmitting}
              onClick={() => submitBook([...selected])}
            >
              {isSubmitting ? "Booking…" : `Book (${selected.size})`}
            </button>
          )}
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#6d7175" }}>
            {orders.length === 0 ? "No orders found in this Shopify store." : "No orders match your search."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["", "Order", "Customer", "City", "Payment", "COD", "Status", "Action"].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((order) => {
                  const booked = order.bookingStatus === "booked";
                  const isSelected = selected.has(order.id);
                  const cod = codValue(order);

                  return (
                    <tr
                      key={order.id}
                      style={{ background: isSelected ? "#f0f4ff" : "transparent", transition: "background 0.1s" }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#fafafa"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? "#f0f4ff" : "transparent"; }}
                    >
                      {/* Checkbox */}
                      <td style={{ ...S.td, width: "36px" }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={booked}
                          onChange={() => toggleRow(order.id)}
                          style={{ width: "15px", height: "15px", cursor: booked ? "not-allowed" : "pointer", opacity: booked ? 0.4 : 1 }}
                        />
                      </td>

                      {/* Order */}
                      <td style={{ ...S.td, fontWeight: "600", color: "#202223" }}>
                        {order.name || `#${order.shopifyId}`}
                      </td>

                      {/* Customer */}
                      <td style={S.td}>
                        <div style={{ fontWeight: "500", color: "#2c6ecb" }}>{order.customerName || "—"}</div>
                        {order.phone && <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "1px" }}>{order.phone}</div>}
                      </td>

                      {/* City */}
                      <td style={{ ...S.td, color: "#202223" }}>{order.city || "—"}</td>

                      {/* Payment */}
                      <td style={S.td}>
                        {order.financialStatus === "paid" ? <PaidBadge /> : (
                          <span style={{ color: "#6d7175", textTransform: "capitalize" }}>{order.financialStatus || "—"}</span>
                        )}
                      </td>

                      {/* COD */}
                      <td style={S.td}>
                        <span style={{ fontWeight: "500" }}>{cod}</span>
                        <span style={{ color: "#6d7175", marginLeft: "3px", fontSize: "12px" }}>{order.currency || "PKR"}</span>
                      </td>

                      {/* Status */}
                      <td style={S.td}>
                        <StatusBadge status={order.bookingStatus} trackingNumber={order.trackingNumber} />
                      </td>

                      {/* Actions */}
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {booked ? (
                          <span style={{ color: "#6d7175", fontSize: "13px" }}>Booked ✓</span>
                        ) : (
                          <>
                            <button
                              style={submittingId === order.id && isSubmitting ? S.btnBookDisabled : S.btnBook}
                              disabled={isSubmitting}
                              onClick={() => submitBook([order.id], order.id)}
                            >
                              {submittingId === order.id && isSubmitting
                                ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Booking…</>
                                : "Book"}
                            </button>
                            <button
                              style={S.btnOptions}
                              disabled={isSubmitting}
                              onClick={() => setModalOrder(order)}
                            >
                              ⚙ Options
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Custom Booking Modal */}
      {modalOrder && (
        <BookingModal
          order={modalOrder}
          settings={settings}
          onClose={() => setModalOrder(null)}
          onConfirm={handleConfirmModal}
        />
      )}

    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
