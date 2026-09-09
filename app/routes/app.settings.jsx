import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncCities } from "../utils/cities.server";
import { detectAndSaveAvailableCouriers } from "../utils/couriers.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [settings, cityCount] = await Promise.all([
    db.settings.findUnique({ where: { shop: session.shop } }),
    db.city.count(),
  ]);
  return {
    instaworldApiKey: settings?.instaworldApiKey || "",
    availableCouriers: Array.isArray(settings?.availableCouriers) ? settings.availableCouriers : [],
    defaultCourier: settings?.defaultCourier || "Auto",
    defaultWeight: settings?.defaultWeight ?? 1,
    defaultInstructions: settings?.defaultInstructions || "",
    shipperName: settings?.shipperName || "",
    shipperPhone: settings?.shipperPhone || "",
    shipperAddress: settings?.shipperAddress || "",
    cityCount,
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  if (form.get("intent") === "syncCities") {
    try {
      const { synced } = await syncCities();
      return { ok: true, citiesSynced: synced };
    } catch (err) {
      console.error("[settings:syncCities] failed:", err.message);
      return { ok: false, error: "Could not sync cities from InstaWorld. Please try again." };
    }
  }

  if (form.get("intent") === "checkCouriers") {
    const settings = await db.settings.findUnique({ where: { shop: session.shop } });
    const apiKey = (form.get("instaworldApiKey") || settings?.instaworldApiKey || "").trim();
    if (!apiKey) {
      return { ok: false, error: "Please enter and save your InstaWorld API key before checking couriers." };
    }
    try {
      const res = await detectAndSaveAvailableCouriers(session.shop, apiKey);
      return {
        ok: true,
        couriersChecked: true,
        availableCouriers: res.availableCouriers,
        defaultCourier: res.defaultCourier,
      };
    } catch (err) {
      console.error("[settings:checkCouriers] failed:", err.message);
      return { ok: false, error: err.message || "Failed to check available couriers." };
    }
  }

  const currentSettings = await db.settings.findUnique({ where: { shop: session.shop } });
  const newApiKey = (form.get("instaworldApiKey") || "").trim() || null;
  const apiKeyChanged = newApiKey && newApiKey !== currentSettings?.instaworldApiKey;

  let defaultCourier = form.get("defaultCourier") || currentSettings?.defaultCourier || "Auto";
  const availableCouriers = Array.isArray(currentSettings?.availableCouriers) ? currentSettings.availableCouriers : [];
  if (defaultCourier !== "Auto" && !availableCouriers.includes(defaultCourier)) {
    defaultCourier = "Auto";
  }

  const settingsData = {
    instaworldApiKey: newApiKey,
    defaultCourier,
    defaultWeight: parseFloat(form.get("defaultWeight")) || 1,
    defaultInstructions: form.get("defaultInstructions") || null,
    shipperName: form.get("shipperName") || null,
    shipperPhone: form.get("shipperPhone") || null,
    shipperAddress: form.get("shipperAddress") || null,
  };

  await db.settings.upsert({
    where: { shop: session.shop },
    update: settingsData,
    create: { shop: session.shop, ...settingsData },
  });

  if (apiKeyChanged && newApiKey) {
    try {
      await detectAndSaveAvailableCouriers(session.shop, newApiKey);
    } catch (e) {
      console.warn("[settings:apiKeyChanged] auto courier detection failed:", e.message);
    }
  }

  return { ok: true };
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  page: {
    padding: "24px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    color: "#202223",
    background: "#f6f6f7",
    minHeight: "100vh",

    /* ✨ CENTERING FIX */
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },

  card: {
    background: "#fff",
    borderRadius: "10px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
    maxWidth: "600px",
    width: "100%",
    overflow: "hidden",
  },

  header: {
    padding: "20px 24px 16px",
    borderBottom: "1px solid #e1e3e5",
  },

  title: { margin: 0, fontSize: "18px", fontWeight: "600" },
  subtitle: { margin: "4px 0 0", color: "#6d7175", fontSize: "13px" },

  form: { padding: "20px 24px" },

  field: { marginBottom: "22px" },

  label: {
    display: "block",
    fontWeight: "600",
    fontSize: "13px",
    marginBottom: "6px",
  },

  required: { color: "#d82c0d" },

  input: {
    width: "100%",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "14px",
    boxSizing: "border-box",
    outline: "none",
    color: "#202223",
  },

  textarea: {
    width: "100%",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "14px",
    boxSizing: "border-box",
    outline: "none",
    resize: "vertical",
    color: "#202223",
    fontFamily: "inherit",
  },

  hint: {
    margin: "5px 0 0",
    color: "#6d7175",
    fontSize: "12px",
  },

  footer: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: "12px",
    paddingTop: "16px",
    borderTop: "1px solid #e1e3e5",
  },

  successMsg: {
    color: "#008060",
    fontSize: "13px",
    fontWeight: "500",
    display: "flex",
    alignItems: "center",
    gap: "5px",
  },

  btnSave: {
    padding: "8px 22px",
    background: "#202223",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "14px",
  },

  btnSaveDisabled: {
    padding: "8px 22px",
    background: "#c9cccf",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "not-allowed",
    fontWeight: "600",
    fontSize: "14px",
  },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const citySyncFetcher = useFetcher();
  const courierFetcher = useFetcher();
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const prevState = useRef("idle");

  const availableCouriers = courierFetcher.data?.availableCouriers || data.availableCouriers || [];
  const defaultCourier = courierFetcher.data?.defaultCourier || data.defaultCourier || "Auto";

  useEffect(() => {
    if (prevState.current !== "idle" && fetcher.state === "idle" && fetcher.data?.ok) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 3000);
      return () => clearTimeout(t);
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  const isSubmitting = fetcher.state !== "idle";
  const isCheckingCouriers = courierFetcher.state !== "idle";

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Header */}
        <div style={S.header}>
          <h2 style={S.title}>InstaWorld Integration</h2>
          <p style={S.subtitle}>
            Configure your InstaWorld courier credentials, available couriers, and booking defaults
          </p>
        </div>

        <fetcher.Form method="POST" style={S.form}>
          {/* API Key */}
          <div style={S.field}>
            <label style={S.label}>
              InstaWorld API Key <span style={S.required}>*</span>
            </label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                name="instaworldApiKey"
                type={showApiKey ? "text" : "password"}
                defaultValue={data.instaworldApiKey}
                placeholder="Enter your InstaWorld API key"
                style={{ ...S.input, fontFamily: showApiKey ? "inherit" : "monospace", letterSpacing: showApiKey ? "normal" : "2px" }}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                style={{ padding: "8px 14px", background: "#f6f6f7", border: "1px solid #c9cccf", borderRadius: "6px", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap", color: "#202223", fontWeight: "500" }}
              >
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
            <p style={S.hint}>
              Used for authentication on every API call. Determines your pickup location and courier assignment.
            </p>
          </div>

          {/* Courier Availability */}
          <div style={S.field}>
            <label style={S.label}>InstaWorld Courier Availability</label>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
              <button
                type="button"
                disabled={isCheckingCouriers}
                onClick={() => courierFetcher.submit({ intent: "checkCouriers" }, { method: "POST" })}
                style={isCheckingCouriers ? S.btnSaveDisabled : { ...S.btnSave, background: "#fff", color: "#202223", border: "1px solid #c9cccf" }}
              >
                {isCheckingCouriers ? "Checking couriers…" : "Check Available Couriers"}
              </button>
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                {availableCouriers.length > 0 ? (
                  availableCouriers.map((c) => (
                    <span
                      key={c}
                      style={{
                        padding: "4px 10px",
                        borderRadius: "14px",
                        fontSize: "12px",
                        fontWeight: "600",
                        background: "#e3f1df",
                        color: "#008060",
                        border: "1px solid #b7e3bd",
                      }}
                    >
                      ✓ {c}
                    </span>
                  ))
                ) : (
                  <span style={{ color: "#6d7175", fontSize: "13px" }}>
                    No specific couriers detected yet
                  </span>
                )}
              </div>
            </div>
            {courierFetcher.data?.ok && (
              <p style={{ ...S.hint, color: "#008060" }}>
                ✓ Checked couriers. Active: {availableCouriers.join(", ") || "None (Auto only)"}
              </p>
            )}
            {courierFetcher.data?.ok === false && (
              <p style={{ ...S.hint, color: "#d82c0d" }}>⚠ {courierFetcher.data.error}</p>
            )}
            <p style={S.hint}>
              Checks which couriers have active credentials configured in your InstaWorld merchant account.
              Only verified active couriers can be selected when booking shipments.
            </p>
          </div>

          {/* Default Courier */}
          <div style={S.field}>
            <label style={S.label}>Default preferred courier</label>
            <select
              name="defaultCourier"
              defaultValue={defaultCourier}
              style={{ ...S.input, maxWidth: "260px" }}
            >
              <option value="Auto">Auto (InstaWorld Default)</option>
              {availableCouriers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p style={S.hint}>
              Pre-selected courier when opening the booking modal. Can be overridden per order.
            </p>
          </div>

          {/* InstaWorld cities */}
          <div style={S.field}>
            <label style={S.label}>InstaWorld serviceable cities</label>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                type="button"
                disabled={citySyncFetcher.state !== "idle"}
                onClick={() => citySyncFetcher.submit({ intent: "syncCities" }, { method: "POST" })}
                style={citySyncFetcher.state !== "idle" ? S.btnSaveDisabled : { ...S.btnSave, background: "#fff", color: "#202223", border: "1px solid #c9cccf" }}
              >
                {citySyncFetcher.state !== "idle" ? "Syncing…" : "Sync cities from InstaWorld"}
              </button>
              <span style={{ color: "#6d7175", fontSize: "13px" }}>
                {data.cityCount > 0 ? `${data.cityCount} cities loaded` : "Not synced yet"}
              </span>
            </div>
            {citySyncFetcher.data?.ok && (
              <p style={{ ...S.hint, color: "#008060" }}>✓ Synced {citySyncFetcher.data.citiesSynced} cities</p>
            )}
            {citySyncFetcher.data?.ok === false && (
              <p style={{ ...S.hint, color: "#d82c0d" }}>⚠ {citySyncFetcher.data.error}</p>
            )}
            <p style={S.hint}>
              Booking screens let merchants pick a city from this list instead of typing one — the #1 cause of
              InstaWorld rejecting a booking is a city name that doesn't exactly match one it services. Re-sync
              if InstaWorld adds coverage you don't see here yet.
            </p>
          </div>

          {/* Default Weight */}
          <div style={S.field}>
            <label style={S.label}>Default item weight (kg)</label>
            <input
              name="defaultWeight"
              type="number"
              defaultValue={data.defaultWeight}
              min="0.1"
              step="0.1"
              style={{ ...S.input, maxWidth: "160px" }}
            />
            <p style={S.hint}>
              Fallback weight per item when booking shipments. Can be overridden in the Options modal per order.
            </p>
          </div>

          {/* Default Instructions */}
          <div style={S.field}>
            <label style={S.label}>Default special instructions</label>
            <textarea
              name="defaultInstructions"
              defaultValue={data.defaultInstructions}
              placeholder="e.g. Handle with care, fragile items"
              rows={3}
              style={S.textarea}
            />
            <p style={S.hint}>
              Pre-fills the instructions field when the Options modal opens. Can be edited per order.
            </p>
          </div>

          {/* Sender info for loadsheet */}
          <div style={{ ...S.field, marginTop: "4px", paddingTop: "18px", borderTop: "1px solid #e1e3e5" }}>
            <label style={{ ...S.label, fontSize: "12px", color: "#6d7175", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Loadsheet sender info
            </label>
            <p style={{ ...S.hint, marginTop: "6px", fontSize: "13px" }}>
              These fields appear on your dispatch loadsheets as the pickup / sender details.
              They do not affect AWB labels — AWB sender info is managed through your InstaWorld merchant account.
            </p>
          </div>

          <div style={S.field}>
            <label style={S.label}>Sender name</label>
            <input
              name="shipperName"
              type="text"
              defaultValue={data.shipperName}
              placeholder="e.g. Your store name"
              style={S.input}
            />
            <p style={S.hint}>Appears as the shop name at the top of every loadsheet.</p>
          </div>

          <div style={S.field}>
            <label style={S.label}>Sender phone</label>
            <input
              name="shipperPhone"
              type="text"
              defaultValue={data.shipperPhone}
              placeholder="e.g. +92 300 1234567"
              style={S.input}
            />
          </div>

          <div style={S.field}>
            <label style={S.label}>Sender address</label>
            <textarea
              name="shipperAddress"
              defaultValue={data.shipperAddress}
              placeholder="e.g. Shop 12, Model Town, Lahore"
              rows={2}
              style={S.textarea}
            />
            <p style={S.hint}>Pickup address shown on every dispatch loadsheet.</p>
          </div>

          {/* Footer */}
          <div style={S.footer}>
            {saved && <span style={S.successMsg}>✓ Settings saved</span>}

            <button
              type="submit"
              style={isSubmitting ? S.btnSaveDisabled : S.btnSave}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Save settings"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);