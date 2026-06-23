import { useState, useEffect } from "react";
import { useFetcher } from "react-router";

const S = {
  page: {
    minHeight: "100vh",
    background: "#f6f6f7",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    color: "#202223",
    padding: "24px",
  },
  card: {
    background: "#fff",
    borderRadius: "12px",
    boxShadow: "0 10px 40px rgba(0,0,0,0.10)",
    maxWidth: "560px",
    width: "100%",
    overflow: "hidden",
  },
  cardHeader: {
    padding: "28px 28px 20px",
    borderBottom: "1px solid #e1e3e5",
  },
  progress: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "20px",
  },
  dot: (active, done) => ({
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    fontWeight: "600",
    background: done ? "#008060" : active ? "#202223" : "#e1e3e5",
    color: active || done ? "#fff" : "#6d7175",
    flexShrink: 0,
  }),
  dotLine: {
    flex: 1,
    height: "2px",
    background: "#e1e3e5",
  },
  stepLabel: (active) => ({
    fontSize: "12px",
    color: active ? "#202223" : "#6d7175",
    fontWeight: active ? "600" : "400",
  }),
  headline: {
    margin: 0,
    fontSize: "20px",
    fontWeight: "700",
    letterSpacing: "-0.3px",
  },
  subline: {
    margin: "6px 0 0",
    color: "#6d7175",
    fontSize: "13px",
    lineHeight: "1.5",
  },
  body: { padding: "24px 28px" },
  field: { marginBottom: "20px" },
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
    padding: "9px 12px",
    fontSize: "14px",
    boxSizing: "border-box",
    outline: "none",
    color: "#202223",
  },
  textarea: {
    width: "100%",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    padding: "9px 12px",
    fontSize: "14px",
    boxSizing: "border-box",
    outline: "none",
    resize: "vertical",
    color: "#202223",
    fontFamily: "inherit",
  },
  hint: { margin: "5px 0 0", color: "#6d7175", fontSize: "12px" },
  errorBox: {
    background: "#fff4f4",
    border: "1px solid #ffc9c9",
    borderRadius: "6px",
    padding: "10px 14px",
    color: "#d82c0d",
    fontSize: "13px",
    marginBottom: "18px",
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 28px 24px",
    borderTop: "1px solid #e1e3e5",
  },
  btnPrimary: (disabled) => ({
    padding: "9px 24px",
    background: disabled ? "#c9cccf" : "#202223",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: "600",
    fontSize: "14px",
  }),
  btnBack: {
    padding: "9px 18px",
    background: "transparent",
    color: "#6d7175",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "500",
    fontSize: "14px",
  },
  btnSkip: {
    background: "none",
    border: "none",
    color: "#6d7175",
    fontSize: "13px",
    cursor: "pointer",
    textDecoration: "underline",
    padding: "0",
  },
  apiKeyRow: { display: "flex", gap: "8px", alignItems: "stretch" },
  btnToggle: {
    padding: "9px 14px",
    background: "#f6f6f7",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "13px",
    whiteSpace: "nowrap",
    color: "#202223",
    fontWeight: "500",
    flexShrink: 0,
  },
};

const STEPS = [
  { label: "Connect" },
  { label: "Profile" },
  { label: "Defaults" },
];

export default function OnboardingWizard({ onComplete }) {
  const fetcher = useFetcher();
  const [step, setStep] = useState(1);
  const [showApiKey, setShowApiKey] = useState(false);
  const [form, setForm] = useState({
    instaworldApiKey: "",
    shipperName: "",
    shipperPhone: "",
    shipperAddress: "",
    defaultWeight: "1",
    defaultInstructions: "",
  });

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const isSubmitting = fetcher.state !== "idle";
  const apiKeyError = fetcher.data?.error;

  useEffect(() => {
    if (fetcher.data?.ok) onComplete();
  }, [fetcher.data]);

  const submit = () =>
    fetcher.submit(form, { method: "POST", action: "/api/onboarding" });

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Header */}
        <div style={S.cardHeader}>
          <div style={S.progress}>
            {STEPS.map((s, i) => {
              const num = i + 1;
              const active = step === num;
              const done = step > num;
              return (
                <div key={num} style={{ display: "flex", alignItems: "center", gap: "8px", flex: i < STEPS.length - 1 ? "1" : "none" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                    <div style={S.dot(active, done)}>{done ? "✓" : num}</div>
                    <span style={S.stepLabel(active)}>{s.label}</span>
                  </div>
                  {i < STEPS.length - 1 && <div style={{ ...S.dotLine, marginBottom: "18px" }} />}
                </div>
              );
            })}
          </div>

          {step === 1 && (
            <>
              <h2 style={S.headline}>Welcome to InstaWorld Booking</h2>
              <p style={S.subline}>
                Book couriers, print AWB labels, and generate dispatch loadsheets — all from inside Shopify.
                Let's get you set up in 3 quick steps.
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <h2 style={S.headline}>Loadsheet Sender Details</h2>
              <p style={S.subline}>
                These details appear on your dispatch loadsheets as the sender / pickup info.
                AWB label sender info is controlled by your InstaWorld merchant account, not this app.
              </p>
            </>
          )}
          {step === 3 && (
            <>
              <h2 style={S.headline}>Booking Defaults</h2>
              <p style={S.subline}>These values pre-fill the booking form. You can always override them per order.</p>
            </>
          )}
        </div>

        {/* Body */}
        <div style={S.body}>
          {step === 1 && (
            <>
              {apiKeyError && <div style={S.errorBox}>{apiKeyError}</div>}
              <div style={S.field}>
                <label style={S.label}>
                  InstaWorld API Key <span style={S.required}>*</span>
                </label>
                <div style={S.apiKeyRow}>
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={form.instaworldApiKey}
                    onChange={update("instaworldApiKey")}
                    placeholder="Paste your InstaWorld API key here"
                    style={{ ...S.input, fontFamily: showApiKey ? "inherit" : "monospace", letterSpacing: showApiKey ? "normal" : "2px" }}
                    autoFocus
                  />
                  <button type="button" onClick={() => setShowApiKey((v) => !v)} style={S.btnToggle}>
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
                <p style={S.hint}>Found in your InstaWorld merchant dashboard under API settings.</p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div style={S.field}>
                <label style={S.label}>Sender name</label>
                <input type="text" value={form.shipperName} onChange={update("shipperName")} placeholder="e.g. Your store name" style={S.input} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Sender phone</label>
                <input type="text" value={form.shipperPhone} onChange={update("shipperPhone")} placeholder="e.g. +92 300 1234567" style={S.input} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Sender address</label>
                <textarea value={form.shipperAddress} onChange={update("shipperAddress")} placeholder="e.g. Shop 12, Model Town, Lahore" rows={2} style={S.textarea} />
                <p style={S.hint}>Appears on loadsheets as the pickup address.</p>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div style={S.field}>
                <label style={S.label}>Default item weight (kg)</label>
                <input type="number" value={form.defaultWeight} onChange={update("defaultWeight")} min="0.1" step="0.1" style={{ ...S.input, maxWidth: "160px" }} />
                <p style={S.hint}>Fallback weight per item. Can be overridden in the booking modal.</p>
              </div>
              <div style={S.field}>
                <label style={S.label}>Default delivery instructions</label>
                <textarea value={form.defaultInstructions} onChange={update("defaultInstructions")} placeholder="e.g. Handle with care, fragile items" rows={3} style={S.textarea} />
                <p style={S.hint}>Pre-fills the instructions field in the booking modal.</p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <div>
            {step > 1 && (
              <button type="button" style={S.btnBack} onClick={() => setStep((s) => s - 1)} disabled={isSubmitting}>
                Back
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {step === 2 && (
              <button type="button" style={S.btnSkip} onClick={() => setStep(3)}>Skip for now</button>
            )}
            {step === 3 && (
              <button type="button" style={S.btnSkip} onClick={submit} disabled={isSubmitting}>Skip for now</button>
            )}
            {step < 3 && (
              <button
                type="button"
                style={S.btnPrimary(step === 1 && !form.instaworldApiKey.trim())}
                onClick={() => setStep((s) => s + 1)}
                disabled={step === 1 && !form.instaworldApiKey.trim()}
              >
                Next
              </button>
            )}
            {step === 3 && (
              <button type="button" style={S.btnPrimary(isSubmitting)} onClick={submit} disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Finish Setup"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
