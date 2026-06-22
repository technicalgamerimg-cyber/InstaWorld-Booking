import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.settings.findUnique({ where: { shop: session.shop } });
  return {
    instaworldApiKey: settings?.instaworldApiKey || "",
    defaultWeight: settings?.defaultWeight ?? 1,
    defaultInstructions: settings?.defaultInstructions || "",
    shipperName: settings?.shipperName || "",
    shipperPhone: settings?.shipperPhone || "",
    shipperAddress: settings?.shipperAddress || "",
    shipperCity: settings?.shipperCity || "",
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const settingsData = {
    instaworldApiKey: form.get("instaworldApiKey") || null,
    defaultWeight: parseFloat(form.get("defaultWeight")) || 1,
    defaultInstructions: form.get("defaultInstructions") || null,
    shipperName: form.get("shipperName") || null,
    shipperPhone: form.get("shipperPhone") || null,
    shipperAddress: form.get("shipperAddress") || null,
    shipperCity: form.get("shipperCity") || null,
  };

  await db.settings.upsert({
    where: { shop: session.shop },
    update: settingsData,
    create: { shop: session.shop, ...settingsData },
  });

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
  const [saved, setSaved] = useState(false);
  const prevState = useRef("idle");

  useEffect(() => {
    if (prevState.current !== "idle" && fetcher.state === "idle" && fetcher.data?.ok) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 3000);
      return () => clearTimeout(t);
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  const isSubmitting = fetcher.state !== "idle";

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Header */}
        <div style={S.header}>
          <h2 style={S.title}>InstaWorld Integration</h2>
          <p style={S.subtitle}>
            Configure your InstaWorld courier credentials and booking defaults
          </p>
        </div>

        <fetcher.Form method="POST" style={S.form}>
          {/* API Key */}
          <div style={S.field}>
            <label style={S.label}>
              InstaWorld API Key <span style={S.required}>*</span>
            </label>
            <input
              name="instaworldApiKey"
              type="text"
              defaultValue={data.instaworldApiKey}
              placeholder="Enter your InstaWorld API key"
              style={S.input}
            />
            <p style={S.hint}>
              Used for authentication on every API call. Determines your pickup location and courier assignment.
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

          {/* Shipper Details Divider */}
          <div style={{ borderTop: "1px solid #e1e3e5", margin: "8px 0 20px" }} />
          <div style={{ fontWeight: "600", fontSize: "14px", marginBottom: "16px", color: "#202223" }}>
            Shipper Details
            <span style={{ fontWeight: "400", fontSize: "12px", color: "#6d7175", marginLeft: "8px" }}>
              Printed on shipping labels
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div style={S.field}>
              <label style={S.label}>Shipper name</label>
              <input name="shipperName" type="text" defaultValue={data.shipperName} placeholder="Your business name" style={S.input} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Shipper phone</label>
              <input name="shipperPhone" type="text" defaultValue={data.shipperPhone} placeholder="03XX-XXXXXXX" style={S.input} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Shipper city</label>
              <input name="shipperCity" type="text" defaultValue={data.shipperCity} placeholder="Lahore" style={S.input} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Shipper address</label>
              <input name="shipperAddress" type="text" defaultValue={data.shipperAddress} placeholder="Street, Area" style={S.input} />
            </div>
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