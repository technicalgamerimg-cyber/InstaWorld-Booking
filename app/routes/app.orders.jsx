import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useNavigate, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import pLimit from "p-limit";
import { graphqlQueryWithRetry } from "../utils/graphql.server";
import { bookOrderWithLiveSync } from "../utils/booking.server";
import { computeOutstandingAmount } from "../utils/orderSync.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const pageSize = [20, 50, 100, 200].includes(limitParam) ? limitParam : 50;
  const skip = (page - 1) * pageSize;

  const status = url.searchParams.get("status") || "all";
  const search = (url.searchParams.get("search") || "").trim();

  const andConditions = [{ shop: session.shop }];

  if (status === "unbooked") {
    andConditions.push({
      OR: [
        { bookingStatus: { not: "booked" } },
        { bookingStatus: null },
      ],
    });
  } else if (status === "booked") {
    andConditions.push({ bookingStatus: "booked" });
  }

  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  // Orders page reads from local DB with pagination and filtering — Shopify sync happens via webhooks / manual sync
  try {
    const [orders, total, counts, shopSettings, cities] = await Promise.all([
      db.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip,
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
      db.order.count({ where }),
      Promise.all([
        db.order.count({ where: { shop: session.shop } }),
        db.order.count({
          where: {
            shop: session.shop,
            OR: [{ bookingStatus: { not: "booked" } }, { bookingStatus: null }],
          },
        }),
        db.order.count({ where: { shop: session.shop, bookingStatus: "booked" } }),
      ]),
      db.settings.findUnique({ where: { shop: session.shop } }),
      db.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      orders: orders.map((o) => ({
        ...o,
        shopifyId: o.shopifyId.toString(),
        createdAt: o.createdAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
      counts: {
        all: counts[0],
        unbooked: counts[1],
        booked: counts[2],
      },
      filters: {
        status,
        search,
      },
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
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
      counts: { all: 0, unbooked: 0, booked: 0 },
      filters: { status: "all", search: "" },
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
            // Outstanding amount, not the original total — see orderSync.server.js's
            // mapOrderNode for why (this is a separate, duplicate query/mapping that
            // predates that fix and needs the same correction).
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
    // Per-order address/phone/city corrections entered right before booking — written
    // back to the real Shopify order (see bookOrderWithLiveSync), not just used for
    // the InstaWorld payload. Keyed by the same numeric order.id as `ids`.
    const overrides = form.get("overrides") ? JSON.parse(form.get("overrides")) : {};

    const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
    if (!shopSettings?.instaworldApiKey) {
      return { ok: false, failures: [{ reason: "InstaWorld API key not configured. Go to Settings first." }], succeeded: 0, failed: 1 };
    }

    const apiKey = shopSettings.instaworldApiKey;
    const defaultWeightKg = shopSettings.defaultWeight ?? 1;

    // Only need id (for the overrides lookup) + shopifyId (for the live fetch) —
    // bookOrderWithLiveSync fetches everything else itself, fresh, at booking time.
    const dbOrders = await db.order.findMany({
      where: { id: { in: ids.map(Number) }, shop: session.shop },
      select: { id: true, shopifyId: true },
    });

    const bookOne = (order) => {
      const override = overrides[order.id] || {};
      return bookOrderWithLiveSync({
        admin,
        shop: session.shop,
        shopifyId: order.shopifyId,
        apiKey,
        weightGrams,
        defaultWeightKg,
        customCod,
        instructions,
        defaultInstructions: shopSettings.defaultInstructions,
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
  tabsWrap: {
    display: "flex",
    borderBottom: "1px solid #e1e3e5",
    background: "#fafbfc",
    padding: "0 12px",
    gap: "4px",
    overflowX: "auto",
  },
  tabBtn: {
    padding: "10px 14px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "500",
    color: "#6d7175",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "2px solid transparent",
    marginBottom: "-1px",
    whiteSpace: "nowrap",
  },
  tabBtnActive: {
    padding: "10px 14px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "600",
    color: "#202223",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "2px solid #202223",
    marginBottom: "-1px",
    whiteSpace: "nowrap",
  },
  tabBadge: {
    fontSize: "11px",
    padding: "1px 6px",
    borderRadius: "10px",
    background: "#e4e5e7",
    color: "#4a4d50",
    fontWeight: "500",
  },
  tabBadgeActive: {
    fontSize: "11px",
    padding: "1px 6px",
    borderRadius: "10px",
    background: "#202223",
    color: "#fff",
    fontWeight: "500",
  },
  paginationWrap: {
    padding: "12px 16px",
    borderTop: "1px solid #e1e3e5",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "12px",
    background: "#fff",
  },
  btnPagination: {
    padding: "6px 14px",
    background: "#fff",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "500",
    color: "#202223",
  },
  btnPaginationDisabled: {
    padding: "6px 14px",
    background: "#f6f6f7",
    border: "1px solid #e1e3e5",
    borderRadius: "6px",
    cursor: "not-allowed",
    fontSize: "13px",
    color: "#8c9196",
  },
  pageSelect: {
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    padding: "5px 8px",
    fontSize: "13px",
    color: "#202223",
    background: "#fff",
    outline: "none",
    cursor: "pointer",
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
  // query's initial value is seeded from value/cities at mount — that's the only
  // sync needed. A useEffect re-deriving query from value on every value change
  // used to live here, but it raced against typing: the first keystroke on an
  // already-picked field fires onChange("") to invalidate the old pick, which
  // changed `value`, which re-ran that effect, which then reset query back to ""
  // a moment later — wiping out the character just typed. query is fully owned
  // by this component's own handlers below; nothing external ever writes `value`
  // without also calling setQuery in the same handler, so no sync effect is needed.
  const selected = cities.find((c) => String(c.id) === String(value));
  const [query, setQuery] = useState(selected?.name || "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

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
        onBlur={() => setOpen(false)}
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
  // Last-known COD is DB-cached and may be stale (see investigation notes) — it's
  // shown only as a reference, never prefilled into the form. Leaving cod blank means
  // "use Shopify's live outstanding amount at booking time"; a stale cached number
  // sitting in the field would otherwise be indistinguishable from a merchant's
  // deliberate override.
  const lastKnownCod = codValue(order);
  const defaultWeightGrams = String(Math.round((settings?.defaultWeight || 1) * 1000));
  const [form, setForm] = useState({
    weight: defaultWeightGrams,
    pieces: "1",
    cod: "",
    instructions: settings?.defaultInstructions || "",
    address: order.address || "",
    phone: order.phone || "",
    cityId: findCityId(cities, order.city),
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const incomplete = !form.cityId || !form.address.trim() || !form.phone.trim();

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
              {[order.customerName, order.city, `Last synced COD ${lastKnownCod} ${order.currency || "PKR"}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#6d7175", lineHeight: 1 }}>✕</button>
        </div>
        {/* Body */}
        <div style={{ padding: "18px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "14px" }}>
            {[
              { label: "Weight (grams)", key: "weight", placeholder: undefined },
              { label: "Pieces", key: "pieces", placeholder: undefined },
              { label: "COD override (optional)", key: "cod", placeholder: `Blank = Shopify's live amount (~${lastKnownCod})` },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>{label}</label>
                <input
                  type="number"
                  value={form[key]}
                  onChange={set(key)}
                  placeholder={placeholder}
                  style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>
                Delivery address <span style={{ color: "#d82c0d" }}>*</span>
              </label>
              <input
                type="text"
                value={form.address}
                onChange={set("address")}
                placeholder="Required"
                style={{ width: "100%", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 10px", fontSize: "14px", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "#202223" }}>
                Phone number <span style={{ color: "#d82c0d" }}>*</span>
              </label>
              <input
                type="text"
                value={form.phone}
                onChange={set("phone")}
                placeholder="Required"
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
            disabled={incomplete}
            title={incomplete ? "Address, phone, and InstaWorld city are all required" : undefined}
            style={incomplete
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
  const [showOnlyIncomplete, setShowOnlyIncomplete] = useState(false);

  const setShare = (k) => (e) => setShared((f) => ({ ...f, [k]: e.target.value }));
  const setRow = (id, k) => (e) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], [k]: e.target.value } }));
  const setRowCity = (id) => (cityId) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], cityId } }));

  const incompleteOrders = orders.filter((o) => {
    const r = rows[o.id];
    return !r?.cityId || !r?.address?.trim() || !r?.phone?.trim();
  });
  const incompleteCount = incompleteOrders.length;
  const displayedOrders = showOnlyIncomplete && incompleteCount > 0 ? incompleteOrders : orders;

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

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: "600", color: "#6d7175" }}>
              Review and correct delivery address / phone / city before booking
            </div>
            {incompleteCount > 0 && (
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <span style={{ fontSize: "12px", color: "#6d7175" }}>View:</span>
                <button
                  type="button"
                  onClick={() => setShowOnlyIncomplete(false)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "4px",
                    border: "1px solid #c9cccf",
                    background: !showOnlyIncomplete ? "#202223" : "#fff",
                    color: !showOnlyIncomplete ? "#fff" : "#6d7175",
                    fontSize: "11px",
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  All ({orders.length})
                </button>
                <button
                  type="button"
                  onClick={() => setShowOnlyIncomplete(true)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "4px",
                    border: "1px solid #d82c0d",
                    background: showOnlyIncomplete ? "#d82c0d" : "#fff",
                    color: showOnlyIncomplete ? "#fff" : "#d82c0d",
                    fontSize: "11px",
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  Needs attention ({incompleteCount})
                </button>
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #e1e3e5", borderRadius: "6px", overflow: "hidden" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["Order", "Address *", "Phone *", "InstaWorld city *"].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayedOrders.map((o) => (
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
                        placeholder="Required"
                        style={{ width: "100%", border: rows[o.id]?.address?.trim() ? "1px solid #c9cccf" : "1px solid #d82c0d", borderRadius: "6px", padding: "6px 8px", fontSize: "13px", boxSizing: "border-box" }}
                      />
                    </td>
                    <td style={S.td}>
                      <input
                        type="text"
                        value={rows[o.id]?.phone ?? ""}
                        onChange={setRow(o.id, "phone")}
                        placeholder="Required"
                        style={{ width: "100%", border: rows[o.id]?.phone?.trim() ? "1px solid #c9cccf" : "1px solid #d82c0d", borderRadius: "6px", padding: "6px 8px", fontSize: "13px", boxSizing: "border-box" }}
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
          {incompleteCount > 0 && (
            <span style={{ color: "#d82c0d", fontSize: "12px", marginRight: "auto" }}>
              {incompleteCount} order{incompleteCount !== 1 ? "s" : ""} still need{incompleteCount === 1 ? "s" : ""} an address, phone, and/or city
            </span>
          )}
          <button onClick={onClose} style={{ padding: "8px 20px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(shared, rows)}
            disabled={incompleteCount > 0}
            title={incompleteCount > 0 ? "Every order needs an address, phone, and InstaWorld city" : undefined}
            style={incompleteCount > 0
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
  const { orders, pagination, counts, filters, settings, cities } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();

  const [searchInput, setSearchInput] = useState(filters?.search || "");
  const [selected, setSelected] = useState(new Set());
  const [modalOrder, setModalOrder] = useState(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [submittingId, setSubmittingId] = useState(null);
  const prevState = useRef("idle");

  useEffect(() => {
    setSearchInput(filters?.search || "");
  }, [filters?.search]);

  useEffect(() => {
    setSelected(new Set());
  }, [pagination?.page, filters?.status, filters?.search, pagination?.pageSize]);

  useEffect(() => {
    if (prevState.current !== "idle" && fetcher.state === "idle") {
      if (fetcher.data?.ok) setSelected(new Set());
      setSubmittingId(null);
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  const updateQuery = (updates) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([k, v]) => {
      if (
        v === null ||
        v === undefined ||
        v === "" ||
        (k === "page" && Number(v) === 1) ||
        (k === "status" && v === "all") ||
        (k === "limit" && Number(v) === 50)
      ) {
        params.delete(k);
      } else {
        params.set(k, String(v));
      }
    });
    const qs = params.toString();
    navigate(qs ? `?${qs}` : ".");
  };

  const bookableOrders = orders.filter((o) => o.bookingStatus !== "booked");
  const allSelected = bookableOrders.length > 0 && bookableOrders.every((o) => selected.has(o.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bookableOrders.map((o) => o.id)));
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
  const activeStatus = filters?.status || "all";
  const currentPage = pagination?.page || 1;
  const totalPages = pagination?.totalPages || 1;
  const pageSize = pagination?.pageSize || 50;
  const totalCount = pagination?.total || 0;

  return (
    <div style={S.page}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={S.card}>
        {/* Search Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateQuery({ search: searchInput.trim(), page: 1 });
          }}
          style={S.searchWrap}
        >
          <span style={S.searchLabel}>Search orders</span>
          <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
            <input
              style={S.searchInput}
              placeholder="Order number, customer name, phone, city..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  updateQuery({ search: "", page: 1 });
                }}
                style={{
                  position: "absolute",
                  right: "10px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#8c9196",
                  fontSize: "14px",
                  padding: "2px 6px",
                  lineHeight: 1,
                }}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button type="submit" style={S.searchBtn}>
            Search
          </button>
          <button
            type="button"
            style={{ ...S.searchBtn, marginLeft: "auto" }}
            disabled={isSubmitting}
            onClick={() => fetcher.submit({ intent: "syncOrders" }, { method: "POST" })}
          >
            {fetcher.data?.synced !== undefined && fetcher.state === "idle" ? `Synced ${fetcher.data.synced}` : "Sync orders"}
          </button>
        </form>

        {/* Status Filter Tabs */}
        <div style={S.tabsWrap}>
          {[
            { key: "all", label: "All orders", count: counts?.all ?? 0 },
            { key: "unbooked", label: "To Book", count: counts?.unbooked ?? 0 },
            { key: "booked", label: "Booked", count: counts?.booked ?? 0 },
          ].map((t) => {
            const isActive = activeStatus === t.key;
            return (
              <button
                key={t.key}
                type="button"
                style={isActive ? S.tabBtnActive : S.tabBtn}
                onClick={() => updateQuery({ status: t.key, page: 1 })}
              >
                <span>{t.label}</span>
                <span style={isActive ? S.tabBadgeActive : S.tabBadge}>{t.count}</span>
              </button>
            );
          })}
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

        {/* Bulk action bar */}
        <div style={S.bulkBar}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            style={{ width: "15px", height: "15px", cursor: "pointer" }}
          />
          <span style={{ color: "#6d7175", fontSize: "13px" }}>
            {selected.size > 0
              ? `${selected.size} selected on this page`
              : `${orders.length} order${orders.length !== 1 ? "s" : ""} on page`}
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
        {orders.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#6d7175" }}>
            {filters?.search
              ? "No orders match your search."
              : activeStatus === "unbooked"
              ? "No unbooked orders. All caught up!"
              : activeStatus === "booked"
              ? "No booked orders yet."
              : "No orders found in this Shopify store."}
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
                {orders.map((order) => {
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

        {/* Pagination Footer */}
        {totalCount > 0 && (
          <div style={S.paginationWrap}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <span style={{ color: "#6d7175", fontSize: "13px" }}>
                Showing <strong>{Math.min((currentPage - 1) * pageSize + 1, totalCount)}</strong>–<strong>{Math.min(currentPage * pageSize, totalCount)}</strong> of <strong>{totalCount}</strong> orders
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#6d7175" }}>
                <label htmlFor="limit-select">Show:</label>
                <select
                  id="limit-select"
                  value={pageSize}
                  onChange={(e) => updateQuery({ limit: Number(e.target.value), page: 1 })}
                  style={S.pageSelect}
                >
                  <option value={20}>20 per page</option>
                  <option value={50}>50 per page</option>
                  <option value={100}>100 per page</option>
                  <option value={200}>200 per page</option>
                </select>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                style={currentPage <= 1 ? S.btnPaginationDisabled : S.btnPagination}
                disabled={currentPage <= 1}
                onClick={() => updateQuery({ page: currentPage - 1 })}
              >
                ← Prev
              </button>
              <span style={{ fontSize: "13px", color: "#6d7175", margin: "0 4px" }}>
                Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong>
              </span>
              <button
                type="button"
                style={currentPage >= totalPages ? S.btnPaginationDisabled : S.btnPagination}
                disabled={currentPage >= totalPages}
                onClick={() => updateQuery({ page: currentPage + 1 })}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Custom Booking Modal */}
      {modalOrder && (
        <BookingModal
          key={modalOrder.id}
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
          key={[...selected].sort().join(",")}
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
