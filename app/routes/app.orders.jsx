import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
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

const shopifyFetch = async (url, options) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // Manual admin-triggered sync — the only path that calls the Shopify API on demand
  if (intent === "syncOrders") {
    const response = await shopifyFetch(
      `https://${session.shop}/admin/api/${apiVersion}/orders.json?status=any&limit=50`,
      { headers: { "X-Shopify-Access-Token": session.accessToken, "Content-Type": "application/json" } }
    );
    const { orders: shopifyOrders = [] } = await response.json();
    for (const o of shopifyOrders) {
      const customerName =
        [o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(" ") ||
        [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") ||
        null;
      await db.order.upsert({
        where: { shopifyId: BigInt(o.id) },
        update: {
          shop: session.shop,
          name: o.name, email: o.email,
          phone: o.phone || o.shipping_address?.phone || null,
          totalPrice: o.total_price, currency: o.currency,
          financialStatus: o.financial_status, fulfillmentStatus: o.fulfillment_status,
          lineItems: o.line_items, customerName,
          city: o.shipping_address?.city || null,
          address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
        },
        create: {
          shopifyId: BigInt(o.id), shop: session.shop,
          name: o.name, email: o.email,
          phone: o.phone || o.shipping_address?.phone || null,
          totalPrice: o.total_price, currency: o.currency,
          financialStatus: o.financial_status, fulfillmentStatus: o.fulfillment_status,
          lineItems: o.line_items, customerName,
          city: o.shipping_address?.city || null,
          address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(", ") || null,
          bookingStatus: "pending",
        },
      });
    }
    return { ok: true, synced: shopifyOrders.length };
  }

  if (intent === "book") {
    const ids = JSON.parse(form.get("orderIds"));
    const weightGrams = form.get("weight") ? parseFloat(form.get("weight")) : null;
    const customCod = form.get("cod") !== null && form.get("cod") !== "" ? parseFloat(form.get("cod")) : null;
    const instructions = form.get("instructions") || null;

    const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
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
        const foUrl = `https://${session.shop}/admin/api/${apiVersion}/orders/${order.shopifyId}/fulfillment_orders.json`;
        const foRes = await shopifyFetch(foUrl, { headers: { "X-Shopify-Access-Token": session.accessToken } });
        if (!foRes.ok) {
          const body = await foRes.text();
          console.error(`[FO fetch] ${order.name} GET ${foUrl} → ${foRes.status}:`, body);
          shopifyFulfillmentError = `HTTP ${foRes.status}: ${body}`;
          shopifyFulfillmentState = "failed";
        } else {
          const { fulfillment_orders = [] } = await foRes.json();
          const openFOs = fulfillment_orders.filter((fo) => fo.status !== "closed" && fo.status !== "cancelled");
          if (openFOs.length > 0) {
            const fulfillUrl = `https://${session.shop}/admin/api/${apiVersion}/fulfillments.json`;
            const fulfillBody = {
              fulfillment: {
                line_items_by_fulfillment_order: openFOs.map((fo) => ({ fulfillment_order_id: fo.id })),
                tracking_info: { number: result.tracking_number, company: result.courier || "InstaWorld" },
                notify_customer: false,
              },
            };
            const fulfillRes = await shopifyFetch(fulfillUrl, {
              method: "POST",
              headers: { "X-Shopify-Access-Token": session.accessToken, "Content-Type": "application/json" },
              body: JSON.stringify(fulfillBody),
            });
            const fulfillData = await fulfillRes.json();
            if (fulfillData.fulfillment?.id) {
              shopifyFulfillmentId = String(fulfillData.fulfillment.id);
              shopifyFulfillmentState = "fulfilled";
            } else {
              const raw = fulfillData.errors;
              const errDetail = Array.isArray(raw)
                ? raw.map((e) => e.message || JSON.stringify(e)).join(", ")
                : raw && typeof raw === "object"
                  ? Object.entries(raw).map(([k, v]) => `${k}: ${v}`).join(", ")
                  : raw ? String(raw) : "Unknown Shopify fulfillment error";
              console.error(`[Fulfillment create] ${order.name} POST ${fulfillUrl} → ${fulfillRes.status}:`, errDetail);
              shopifyFulfillmentError = raw ?? errDetail;
              shopifyFulfillmentState = "failed";
            }
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
