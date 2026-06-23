import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
import db from "../db.server";
import pLimit from "p-limit";
import { cancelShipment } from "../utils/instaworld.server";
const PAGE_SIZE = 50;

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const skip = (page - 1) * PAGE_SIZE;

  const orderWhere = { shop: session.shop, bookingStatus: "booked", trackingNumber: { not: null } };

  const [orders, total, loadsheets] = await Promise.all([
    db.order.findMany({
      where: orderWhere,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip,
      select: {
        id: true,
        shopifyId: true,
        name: true,
        customerName: true,
        phone: true,
        city: true,
        address: true,
        email: true,
        totalPrice: true,
        currency: true,
        financialStatus: true,
        trackingNumber: true,
        courierName: true,
        shopifyFulfillmentId: true,
        createdAt: true,
      },
    }),
    db.order.count({ where: orderWhere }),
    db.loadsheet.findMany({
      where: { shop: session.shop },
      orderBy: { generatedAt: "desc" },
      take: 20,
      select: { id: true, generatedAt: true, orderCount: true, totalCOD: true, filename: true },
    }),
  ]);

  return {
    orders: orders.map((o) => ({
      ...o,
      shopifyId: o.shopifyId.toString(),
      createdAt: o.createdAt.toISOString(),
    })),
    pagination: {
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    },
    loadsheets: loadsheets.map((l) => ({ ...l, generatedAt: l.generatedAt.toISOString() })),
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
  if (!shopSettings?.instaworldApiKey) {
    return { ok: false, error: "InstaWorld API key not configured. Go to Settings first." };
  }

  const shopifyFetch = async (url, options) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // cancelOne accepts an order object — DB fetch is done upfront (no N+1)
  const cancelOne = async (order) => {
    if (!order) return;

    if (order.trackingNumber) {
      try {
        await cancelShipment(order.trackingNumber, shopSettings.instaworldApiKey);
      } catch (e) {
        console.error(`InstaWorld cancel error for ${order.name}:`, e.message);
      }
    }

    let cancelObservation = "cancelled_attempted";

    if (order.shopifyId) {
      try {
        if (order.shopifyFulfillmentId) {
          const cancelUrl = `https://${session.shop}/admin/api/${apiVersion}/fulfillments/${order.shopifyFulfillmentId}/cancel.json`;
          const cancelRes = await shopifyFetch(cancelUrl, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": session.accessToken, "Content-Type": "application/json" },
          });
          if (cancelRes.ok) {
            console.log(`[FulfillmentCancel] ${order.name} → success`);
          } else {
            const body = await cancelRes.text();
            console.warn(`[FulfillmentCancel] ${order.name} POST ${cancelUrl} → ${cancelRes.status}:`, body);
            if (cancelRes.status === 422) cancelObservation = "irreversible";
          }
        }

        const foUrl = `https://${session.shop}/admin/api/${apiVersion}/orders/${order.shopifyId}/fulfillment_orders.json`;
        const foRes = await shopifyFetch(foUrl, { headers: { "X-Shopify-Access-Token": session.accessToken } });
        if (foRes.ok) {
          const { fulfillment_orders = [] } = await foRes.json();
          const CANCELLABLE = new Set(["open", "assigned", "in_progress", "scheduled"]);
          for (const fo of fulfillment_orders) {
            if (CANCELLABLE.has(fo.status)) {
              const foCancelUrl = `https://${session.shop}/admin/api/${apiVersion}/fulfillment_orders/${fo.id}/cancel.json`;
              const foCancel = await shopifyFetch(foCancelUrl, {
                method: "POST",
                headers: { "X-Shopify-Access-Token": session.accessToken, "Content-Type": "application/json" },
              });
              if (!foCancel.ok) {
                const body = await foCancel.text();
                console.warn(`[FOCancel] ${order.name} FO ${fo.id} → ${foCancel.status}:`, body);
              }
            }
          }
        } else {
          const body = await foRes.text();
          console.error(`[FO fetch] ${order.name} GET ${foUrl} → ${foRes.status}:`, body);
          cancelObservation = "failed";
        }
      } catch (e) {
        console.error(`[ShopifyCancel] ${order.name}:`, e.message);
        cancelObservation = "failed";
      }
    }

    await db.order.update({
      where: { id: order.id },
      data: {
        bookingStatus: "pending",
        shipmentStatus: "cancelled",
        trackingNumber: null,
        shopifyFulfillmentId: null,
        shopifyFulfillmentState: cancelObservation,
        shopifySyncStatus: cancelObservation === "cancelled_attempted" ? "synced" : "failed",
      },
    });
  };

  if (intent === "cancelSingle") {
    const singleOrder = await db.order.findFirst({
      where: { id: Number(form.get("orderId")), shop: session.shop },
      select: { id: true, shopifyId: true, name: true, trackingNumber: true, shopifyFulfillmentId: true },
    });
    if (singleOrder) await cancelOne(singleOrder);
    return { ok: true };
  }

  if (intent === "cancelBulk") {
    const ids = JSON.parse(form.get("orderIds"));
    // Fetch all target orders upfront — 1 DB query instead of N (eliminates N+1)
    const bulkOrders = await db.order.findMany({
      where: { id: { in: ids.map(Number) }, shop: session.shop },
      select: { id: true, shopifyId: true, name: true, trackingNumber: true, shopifyFulfillmentId: true },
    });
    const orderMap = new Map(bulkOrders.map((o) => [o.id, o]));
    const limit = pLimit(5);
    await Promise.allSettled(
      ids.map((id) => {
        const order = orderMap.get(Number(id));
        if (!order) return { id: Number(id), skipped: true, reason: "not_found" };
        return limit(() => cancelOne(order));
      })
    );
    return { ok: true, cancelled: ids.length };
  }

  return { ok: true };
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  page: {
    padding: "20px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    color: "#202223",
    background: "#f6f6f7",
    minHeight: "100vh",
  },
  card: { background: "#fff", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", overflow: "hidden" },
  searchWrap: { padding: "12px 16px", borderBottom: "1px solid #e1e3e5", display: "flex", gap: "8px", alignItems: "center" },
  searchLabel: { fontWeight: "600", whiteSpace: "nowrap" },
  searchInput: { flex: 1, border: "1px solid #c9cccf", borderRadius: "6px", padding: "6px 10px", fontSize: "14px", outline: "none" },
  bulkBar: { padding: "8px 16px", borderBottom: "1px solid #e1e3e5", display: "flex", alignItems: "center", gap: "10px", background: "#fafafa" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { padding: "10px 12px", textAlign: "left", fontWeight: "600", color: "#6d7175", fontSize: "12px", borderBottom: "1px solid #e1e3e5", background: "#f6f6f7", whiteSpace: "nowrap" },
  td: { padding: "10px 12px", borderBottom: "1px solid #f1f1f1", verticalAlign: "middle" },
  btnCancel: { padding: "5px 14px", background: "#fff", color: "#d82c0d", border: "1px solid #d82c0d", borderRadius: "5px", cursor: "pointer", fontWeight: "500", fontSize: "13px" },
  btnDownload: { padding: "5px 14px", background: "#fff", color: "#2c6ecb", border: "1px solid #2c6ecb", borderRadius: "5px", cursor: "pointer", fontWeight: "500", fontSize: "13px", marginRight: "6px" },
  btnBulkCancel: { padding: "6px 16px", background: "#d82c0d", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600", fontSize: "13px" },
  btnBulkDownload: { padding: "6px 16px", background: "#2c6ecb", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600", fontSize: "13px" },
  btnPagination: { padding: "6px 14px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "500" },
  errorBanner: { padding: "10px 16px", background: "#fff4f4", color: "#d82c0d", borderBottom: "1px solid #ffc9c9", fontSize: "13px" },
  successBanner: { padding: "10px 16px", background: "#f0fff4", color: "#1a7f4b", borderBottom: "1px solid #b7eacb", fontSize: "13px" },
};

// ─── Cancel Confirm Modal ─────────────────────────────────────────────────────

function CancelConfirmModal({ ids, orders, onConfirm, onClose }) {
  const isBulk = ids.length > 1;
  const order = !isBulk ? orders.find((o) => o.id === ids[0]) : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: "10px", width: "440px", maxWidth: "95vw", boxShadow: "0 8px 32px rgba(0,0,0,0.2)", overflow: "hidden" }}>
        <div style={{ padding: "20px 20px 14px", borderBottom: "1px solid #e1e3e5", display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "22px" }}>⚠</span>
          <div style={{ fontWeight: "700", fontSize: "16px", color: "#d82c0d" }}>
            {isBulk ? `Cancel ${ids.length} shipments?` : "Cancel booking?"}
          </div>
        </div>
        <div style={{ padding: "18px 20px" }}>
          {isBulk ? (
            <p style={{ margin: 0, color: "#202223", lineHeight: "1.6" }}>
              This will cancel <strong>{ids.length}</strong> InstaWorld shipments and their Shopify fulfillments.{" "}
              <span style={{ color: "#6d7175", fontSize: "13px" }}>This cannot be undone.</span>
            </p>
          ) : (
            <p style={{ margin: 0, color: "#202223", lineHeight: "1.6" }}>
              This will cancel the InstaWorld shipment and Shopify fulfillment for{" "}
              <strong>{order?.name || `#${order?.shopifyId}`}</strong>.<br />
              <span style={{ color: "#6d7175", fontSize: "13px" }}>This cannot be undone.</span>
            </p>
          )}
        </div>
        <div style={{ padding: "12px 20px 18px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button onClick={onClose} style={{ padding: "8px 20px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}>
            Keep booking
          </button>
          <button onClick={onConfirm} style={{ padding: "8px 20px", background: "#d82c0d", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>
            Yes, cancel {isBulk ? "all" : "booking"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ShipmentsPage() {
  const { orders, pagination, loadsheets } = useLoaderData();
  const navigate = useNavigate();
  const cancelFetcher = useFetcher();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [cancelConfirmIds, setCancelConfirmIds] = useState(null);
  const [zipLoading, setZipLoading] = useState(false);
  const [loadsheetLoading, setLoadsheetLoading] = useState(false);
  const prevCancelState = useRef("idle");

  useEffect(() => {
    if (prevCancelState.current !== "idle" && cancelFetcher.state === "idle") {
      if (cancelFetcher.data?.ok || cancelFetcher.data?.cancelled > 0) {
        setSelected(new Set());
      }
    }
    prevCancelState.current = cancelFetcher.state;
  }, [cancelFetcher.state, cancelFetcher.data]);

  const filtered = orders.filter((o) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (o.name || "").toLowerCase().includes(q) ||
      (o.customerName || "").toLowerCase().includes(q) ||
      (o.trackingNumber || "").toLowerCase().includes(q)
    );
  });

  const allSelected = filtered.length > 0 && filtered.every((o) => selected.has(o.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((o) => o.id)));
    }
  };

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleConfirmCancel = () => {
    const ids = cancelConfirmIds;
    if (ids.length === 1) {
      cancelFetcher.submit(
        { intent: "cancelSingle", orderId: String(ids[0]) },
        { method: "POST" }
      );
    } else {
      cancelFetcher.submit(
        { intent: "cancelBulk", orderIds: JSON.stringify(ids) },
        { method: "POST" }
      );
    }
    setCancelConfirmIds(null);
  };

  const downloadAWB = async (trackingNumber) => {
    const res = await fetch(`/api/awb/${encodeURIComponent(trackingNumber)}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `awb-${trackingNumber}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadBulkAWB = async () => {
    const selectedIds = new Set(selected);
    const targets = orders.filter((o) => selectedIds.has(o.id) && o.trackingNumber);
    if (targets.length === 0) return;
    setZipLoading(true);
    try {
      const res = await fetch("/api/awb/bulk-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: targets.map((o) => o.id) }),
      });
      if (!res.ok) throw new Error("PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `awb-labels-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setZipLoading(false);
    }
  };

  const downloadLoadsheet = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setLoadsheetLoading(true);
    try {
      const res = await fetch("/api/loadsheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Loadsheet generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `loadsheet-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      navigate(".", { replace: true }); // refresh to show new history entry
    } catch (e) {
      console.error("Loadsheet error:", e.message);
    } finally {
      setLoadsheetLoading(false);
    }
  };

  const redownloadLoadsheet = async (id, filename) => {
    const res = await fetch(`/api/loadsheet/${id}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `loadsheet-${id}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isCancelling = cancelFetcher.state !== "idle";
  const cancelResult = cancelFetcher.data;

  return (
    <div style={S.page}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={S.card}>
        {/* Search */}
        <div style={S.searchWrap}>
          <span style={S.searchLabel}>Shipments</span>
          <input
            style={S.searchInput}
            placeholder="Order number, customer, tracking..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Status banners */}
        {cancelResult?.error && <div style={S.errorBanner}>⚠ {cancelResult.error}</div>}
        {cancelResult?.cancelled > 0 && cancelResult?.failed > 0 && (
          <div style={S.errorBanner}>
            Cancelled {cancelResult.cancelled}, failed {cancelResult.failed} — {cancelResult.failures.join(" · ")}
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
            {selected.size > 0 ? `${selected.size} selected` : `${pagination.total} shipment${pagination.total !== 1 ? "s" : ""}`}
          </span>

          {selected.size > 0 && (() => {
            const withTracking = orders.filter((o) => selected.has(o.id) && o.trackingNumber);
            const skipped = selected.size - withTracking.length;
            const anyExporting = zipLoading || loadsheetLoading;
            return (
              <>
                <button
                  style={S.btnBulkDownload}
                  disabled={isCancelling || anyExporting}
                  onClick={downloadBulkAWB}
                >
                  {zipLoading
                    ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Preparing…</>
                    : `AWB Labels (${withTracking.length})${skipped > 0 ? ` · ${skipped} skipped` : ""}`}
                </button>
                <button
                  style={{ ...S.btnBulkDownload, background: "#1a5c3a" }}
                  disabled={isCancelling || anyExporting}
                  onClick={downloadLoadsheet}
                >
                  {loadsheetLoading
                    ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Generating…</>
                    : `Dispatch Loadsheet (${selected.size})`}
                </button>
                <button
                  style={S.btnBulkCancel}
                  disabled={isCancelling || anyExporting}
                  onClick={() => setCancelConfirmIds([...selected])}
                >
                  {isCancelling
                    ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Cancelling…</>
                    : `Cancel selected (${selected.size})`}
                </button>
              </>
            );
          })()}
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#6d7175" }}>
            {orders.length === 0 ? "No booked shipments yet. Book orders from the Orders page." : "No shipments match your search."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["", "Order", "Customer", "City", "COD", "Tracking #", "Courier", "Booked At", "Actions"].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((order) => {
                  const cod = order.financialStatus === "paid" ? "0" : (order.totalPrice || "0");
                  const isSelected = selected.has(order.id);
                  const bookedDate = new Date(order.createdAt).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" });

                  return (
                    <tr
                      key={order.id}
                      style={{ background: isSelected ? "#f0f4ff" : "transparent", transition: "background 0.1s" }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#fafafa"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? "#f0f4ff" : "transparent"; }}
                    >
                      <td style={{ ...S.td, width: "36px" }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(order.id)}
                          style={{ width: "15px", height: "15px", cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ ...S.td, fontWeight: "600", color: "#202223" }}>{order.name || `#${order.shopifyId}`}</td>
                      <td style={S.td}>
                        <div style={{ fontWeight: "500", color: "#2c6ecb" }}>{order.customerName || "—"}</div>
                        {order.phone && <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "1px" }}>{order.phone}</div>}
                      </td>
                      <td style={{ ...S.td, color: "#202223" }}>{order.city || "—"}</td>
                      <td style={S.td}>
                        <span style={{ fontWeight: "500" }}>{cod}</span>
                        <span style={{ color: "#6d7175", marginLeft: "3px", fontSize: "12px" }}>{order.currency || "PKR"}</span>
                      </td>
                      <td style={S.td}>
                        {order.trackingNumber ? (
                          <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#202223" }}>{order.trackingNumber}</span>
                        ) : "—"}
                      </td>
                      <td style={{ ...S.td, color: "#6d7175" }}>{order.courierName || "—"}</td>
                      <td style={{ ...S.td, color: "#6d7175", fontSize: "12px", whiteSpace: "nowrap" }}>{bookedDate}</td>
                      <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                        {order.trackingNumber && (
                          <button
                            style={S.btnDownload}
                            disabled={isCancelling}
                            onClick={() => downloadAWB(order.trackingNumber)}
                          >
                            Label
                          </button>
                        )}
                        <button
                          style={S.btnCancel}
                          disabled={isCancelling}
                          onClick={() => setCancelConfirmIds([order.id])}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div style={{ padding: "12px 16px", borderTop: "1px solid #e1e3e5", display: "flex", alignItems: "center", gap: "10px", justifyContent: "flex-end" }}>
            <span style={{ color: "#6d7175", fontSize: "13px" }}>
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </span>
            <button
              style={S.btnPagination}
              disabled={pagination.page <= 1}
              onClick={() => navigate(`?page=${pagination.page - 1}`)}
            >
              ← Prev
            </button>
            <button
              style={S.btnPagination}
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => navigate(`?page=${pagination.page + 1}`)}
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Cancel Confirm Modal */}
      {cancelConfirmIds !== null && (
        <CancelConfirmModal
          ids={cancelConfirmIds}
          orders={orders}
          onClose={() => setCancelConfirmIds(null)}
          onConfirm={handleConfirmCancel}
        />
      )}

      {/* Loadsheet History */}
      {loadsheets.length > 0 && (
        <div style={{ ...S.card, marginTop: "20px" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e1e3e5", fontWeight: "600", fontSize: "14px" }}>
            Loadsheet History
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["Generated", "Orders", "Total COD (PKR)", ""].map((h, i) => (
                    <th key={i} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadsheets.map((ls) => {
                  const genDate = new Date(ls.generatedAt).toLocaleString("en-PK", {
                    day: "2-digit", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  });
                  return (
                    <tr key={ls.id}>
                      <td style={S.td}>{genDate}</td>
                      <td style={S.td}>{ls.orderCount}</td>
                      <td style={S.td}>{ls.totalCOD.toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>
                        <button
                          style={S.btnDownload}
                          onClick={() => redownloadLoadsheet(ls.id, ls.filename)}
                        >
                          Download
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
