import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import pLimit from "p-limit";
import { graphqlQueryWithRetry } from "../utils/graphql.server";
import { bookOrderShipment, defaultCodValue } from "../utils/booking.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Orders page is now a pure DB read — Shopify sync happens via webhooks (api.webhooks.jsx)
  try {
    const [orders, shopSettings, cities] = await Promise.all([
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
          address: true,
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
      db.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
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
      cities,
    };
  } catch (err) {
    console.error("[loader:orders] DB error:", err.message);
    return {
      orders: [],
      settings: { defaultWeight: 1, defaultInstructions: "" },
      cities: [],
      error: "Could not load orders.",
    };
  }
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // Manual admin-triggered sync — the only path that calls the Shopify API on demand
  if (intent === "syncOrders") {
    try {
      const SYNC_QUERY = `
        #graphql
        query SyncOrders($cursor: String) {
          orders(first: 50, sortKey: CREATED_AT, reverse: true, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
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
          }
        }
      `;

      let cursor = null;
      let synced = 0;

      do {
        const data = await graphqlQueryWithRetry(admin, SYNC_QUERY, { cursor }, "SyncOrders");
        const page = data?.orders;
        const nodes = page?.edges?.map(({ node }) => node) ?? [];

        for (const node of nodes) {
          let numericId;
          try {
            const idPart = node.id?.split("/").pop();
            if (!idPart) { console.warn("[syncOrders] Skipping node with missing id:", node.id); continue; }
            numericId = BigInt(idPart);
          } catch (e) {
            console.warn("[syncOrders] Skipping malformed GID:", node.id, e.message);
            continue;
          }

          const customerName =
            [node.shippingAddress?.firstName, node.shippingAddress?.lastName].filter(Boolean).join(" ") ||
            [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null;

          const lineItems = (node.lineItems?.edges ?? []).map(({ node: li }) => ({
            title: li.title ?? "",
            price: li.originalUnitPriceSet?.shopMoney?.amount ?? "0",
            quantity: li.quantity ?? 1,
            sku: li.sku ?? "",
          }));

          const orderFields = {
            shop: session.shop,
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
          };

          await db.order.upsert({
            where: { shopifyId: numericId },
            update: orderFields,
            create: { shopifyId: numericId, ...orderFields, bookingStatus: "pending" },
          });
          synced++;
        }

        cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      } while (cursor);

      return { ok: true, synced };
    } catch (err) {
      console.error("[syncOrders] failed:", err.message);
      return { ok: false, error: "Unable to sync orders. Please try again." };
    }
  }

  if (intent === "book") {
    const ids = JSON.parse(form.get("orderIds"));
    const weightGrams = form.get("weight") ? parseFloat(form.get("weight")) : null;
    const customCod = form.get("cod") !== null && form.get("cod") !== "" ? parseFloat(form.get("cod")) : null;
    const instructions = form.get("instructions") || null;
    // Per-order address/phone corrections entered right before booking — one-time
    // overrides for the InstaWorld payload only, never written back to the Order
    // record or the Shopify order. Keyed by the same numeric order.id as `ids`.
    const overrides = form.get("overrides") ? JSON.parse(form.get("overrides")) : {};

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

      const codAmount = customCod !== null ? customCod : defaultCodValue(order);
      const override = overrides[order.id] || {};

      return bookOrderShipment({
        admin,
        order,
        apiKey,
        weightKg,
        codAmount,
        instructions: instructions ?? shopSettings.defaultInstructions ?? "",
        addressOverride: override.address,
        phoneOverride: override.phone,
        cityOverride: override.city,
      });
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

// ─── City select ─────────────────────────────────────────────────────────────

// InstaWorld only recognizes exact names from its own city list — a free-typed
// city (typo, extra address text, a district it doesn't service) is the #1 cause
// of booking failures. This forces a pick from that list instead of free text.
function findCityId(cities, cityName) {
  if (!cityName) return "";
  const match = cities.find((c) => c.name.toLowerCase() === cityName.trim().toLowerCase());
  return match ? String(match.id) : "";
}

function CitySelect({ cities, value, onChange }) {
  const selected = cities.find((c) => String(c.id) === String(value));
  const [query, setQuery] = useState(selected?.name || "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

  // Keep the input text in sync when the selection changes from outside
  // (e.g. a fresh row is added to the bulk table after this component mounted).
  useEffect(() => {
    const sel = cities.find((c) => String(c.id) === String(value));
    setQuery(sel?.name || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = q ? cities.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50) : [];

  const pick = (city) => {
    onChange(String(city.id));
    setQuery(city.name);
    setOpen(false);
  };

  const handleInput = (e) => {
    const next = e.target.value;
    setQuery(next);
    setOpen(true);
    setHighlight(0);
    if (value) onChange(""); // typing invalidates the previous pick until a new one is made
  };

  const handleKeyDown = (e) => {
    if (!open || matches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(matches[highlight]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        onChange={handleInput}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
        placeholder="Type to search InstaWorld cities…"
        style={{ width: "100%", border: value ? "1px solid #008060" : "1px solid #c9cccf", borderRadius: "6px", padding: "7px 8px", fontSize: "13px", boxSizing: "border-box" }}
      />
      {open && matches.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", marginTop: "3px", maxHeight: "220px", overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,0.15)" }}>
          {matches.map((c, i) => (
            <div
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHighlight(i)}
              style={{ padding: "7px 10px", fontSize: "13px", cursor: "pointer", background: i === highlight ? "#f0f4ff" : "#fff" }}
            >
              {c.name}
            </div>
          ))}
        </div>
      )}
      {open && q && matches.length === 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", marginTop: "3px", padding: "8px 10px", fontSize: "12px", color: "#6d7175" }}>
          No matching city
        </div>
      )}
    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function BookingModal({ order, settings, cities, onClose, onConfirm }) {
  const cod = codValue(order);
  const defaultWeightGrams = String(Math.round((settings?.defaultWeight || 1) * 1000));
  const [form, setForm] = useState({
    weight: defaultWeightGrams,
    pieces: "1",
    cod,
    instructions: settings?.defaultInstructions || "",
    address: order.address || "",
    phone: order.phone || "",
    cityId: findCityId(cities, order.city),
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>Delivery address</label>
              <input
                type="text"
                value={form.address}
                onChange={set("address")}
                placeholder={order.city || "No address on file"}
                style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>Phone number</label>
              <input
                type="text"
                value={form.phone}
                onChange={set("phone")}
                placeholder="No phone on file"
                style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
              />
            </div>
          </div>
          <div style={{ marginBottom: "14px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>
              InstaWorld city <span style={{ color: "#d82c0d" }}>*</span>
            </label>
            <CitySelect cities={cities} value={form.cityId} onChange={(id) => setForm((f) => ({ ...f, cityId: id }))} />
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
          <button
            onClick={() => onConfirm(form)}
            disabled={!form.cityId}
            title={!form.cityId ? "Select an InstaWorld city first" : undefined}
            style={!form.cityId
              ? { padding: "8px 20px", background: "#c9cccf", color: "#fff", border: "none", borderRadius: "6px", cursor: "not-allowed", fontWeight: "600" }
              : { padding: "8px 20px", background: "#202223", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}
          >
            Confirm booking
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkBookingModal({ orders, settings, cities, onClose, onConfirm }) {
  const defaultWeightGrams = String(Math.round((settings?.defaultWeight || 1) * 1000));
  const [shared, setShared] = useState({
    weight: defaultWeightGrams,
    cod: "",
    instructions: settings?.defaultInstructions || "",
  });
  const [rows, setRows] = useState(() =>
    Object.fromEntries(orders.map((o) => [o.id, {
      address: o.address || "",
      phone: o.phone || "",
      cityId: findCityId(cities, o.city),
    }]))
  );

  const setShare = (k) => (e) => setShared((f) => ({ ...f, [k]: e.target.value }));
  const setRow = (id, k) => (e) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], [k]: e.target.value } }));
  const setRowCity = (id) => (cityId) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], cityId } }));

  const missingCity = orders.filter((o) => !rows[o.id]?.cityId).length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: "10px", width: "760px", maxWidth: "95vw", maxHeight: "90vh", boxShadow: "0 8px 32px rgba(0,0,0,0.2)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ padding: "18px 20px 12px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ fontWeight: "700", fontSize: "16px" }}>
            🛵 Bulk booking — {orders.length} orders
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#6d7175", lineHeight: 1 }}>✕</button>
        </div>
        {/* Body */}
        <div style={{ padding: "18px 20px", overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>Weight (grams) — applied to all</label>
              <input
                type="number"
                value={shared.weight}
                onChange={setShare("weight")}
                style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>COD override (optional)</label>
              <input
                type="number"
                value={shared.cod}
                onChange={setShare("cod")}
                placeholder="Leave blank to use each order's total"
                style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
              />
            </div>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>Special instructions — applied to all</label>
            <textarea
              value={shared.instructions}
              onChange={setShare("instructions")}
              rows={2}
              style={{ width: "100%", border: "1px solid #5c6ac4", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", resize: "vertical", boxSizing: "border-box", outline: "none" }}
            />
          </div>

          <div style={{ fontSize: "12px", fontWeight: "600", color: "#6d7175", marginBottom: "6px" }}>
            Review and correct each order's delivery address / phone / city before booking
          </div>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: "6px", overflow: "hidden" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["Order", "Address", "Phone", "InstaWorld city *"].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: "600" }}>{o.name || `#${o.shopifyId}`}</div>
                      <div style={{ color: "#6d7175", fontSize: "12px" }}>{o.customerName || "—"}</div>
                    </td>
                    <td style={S.td}>
                      <input
                        type="text"
                        value={rows[o.id]?.address ?? ""}
                        onChange={setRow(o.id, "address")}
                        placeholder={o.city || "No address on file"}
                        style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "6px 8px", fontSize: "13px", boxSizing: "border-box" }}
                      />
                    </td>
                    <td style={S.td}>
                      <input
                        type="text"
                        value={rows[o.id]?.phone ?? ""}
                        onChange={setRow(o.id, "phone")}
                        placeholder="No phone on file"
                        style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "6px 8px", fontSize: "13px", boxSizing: "border-box" }}
                      />
                    </td>
                    <td style={{ ...S.td, minWidth: "170px" }}>
                      <CitySelect cities={cities} value={rows[o.id]?.cityId} onChange={setRowCity(o.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {/* Footer */}
        <div style={{ padding: "12px 20px 18px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "10px", borderTop: "1px solid #e1e3e5" }}>
          {missingCity > 0 && (
            <span style={{ color: "#d82c0d", fontSize: "12px", marginRight: "auto" }}>
              {missingCity} order{missingCity !== 1 ? "s" : ""} still need{missingCity === 1 ? "s" : ""} a city
            </span>
          )}
          <button onClick={onClose} style={{ padding: "8px 20px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(shared, rows)}
            disabled={missingCity > 0}
            title={missingCity > 0 ? "Select an InstaWorld city for every order first" : undefined}
            style={missingCity > 0
              ? { padding: "8px 20px", background: "#c9cccf", color: "#fff", border: "none", borderRadius: "6px", cursor: "not-allowed", fontWeight: "600" }
              : { padding: "8px 20px", background: "#202223", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}
          >
            Confirm booking ({orders.length})
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { orders, settings, cities } = useLoaderData();
  const fetcher = useFetcher();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [modalOrder, setModalOrder] = useState(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
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

  const cityName = (id) => cities.find((c) => String(c.id) === String(id))?.name || "";

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
        overrides: JSON.stringify({ [modalOrder.id]: { address: form.address, phone: form.phone, city: cityName(form.cityId) } }),
      },
      { method: "POST" }
    );
    setModalOrder(null);
  };

  const handleConfirmBulkModal = (shared, rows) => {
    const ids = [...selected];
    const overrides = Object.fromEntries(
      Object.entries(rows).map(([id, r]) => [id, { address: r.address, phone: r.phone, city: cityName(r.cityId) }])
    );
    fetcher.submit(
      {
        intent: "book",
        orderIds: JSON.stringify(ids),
        weight: shared.weight,
        cod: shared.cod,
        instructions: shared.instructions,
        overrides: JSON.stringify(overrides),
      },
      { method: "POST" }
    );
    setBulkModalOpen(false);
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

        {/* Sync error banner */}
        {fetcher.state === "idle" && fetcher.data?.ok === false && fetcher.data?.error && !fetcher.data?.failures && (
          <div style={S.errorBanner}>⚠ {fetcher.data.error}</div>
        )}

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
              onClick={() => setBulkModalOpen(true)}
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
                          <button
                            style={submittingId === order.id && isSubmitting ? S.btnBookDisabled : S.btnBook}
                            disabled={isSubmitting}
                            onClick={() => setModalOrder(order)}
                          >
                            {submittingId === order.id && isSubmitting
                              ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Booking…</>
                              : "Book"}
                          </button>
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
          cities={cities}
          onClose={() => setModalOrder(null)}
          onConfirm={handleConfirmModal}
        />
      )}

      {/* Bulk Booking Modal */}
      {bulkModalOpen && (
        <BulkBookingModal
          orders={orders.filter((o) => selected.has(o.id))}
          settings={settings}
          cities={cities}
          onClose={() => setBulkModalOpen(false)}
          onConfirm={handleConfirmBulkModal}
        />
      )}

    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
