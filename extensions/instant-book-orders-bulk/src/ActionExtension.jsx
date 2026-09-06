import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Must match `application_url` in shopify.app.toml — extensions run on a
// Shopify-hosted origin and can't read the app's server env, so this is fixed here.
const APP_URL = "https://instant-bulk-booking.vercel.app";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n, close, data, auth } = shopify;
  const orderGids = data.selected.map((r) => r.id);
  const count = orderGids.length;

  const [phase, setPhase] = useState("loading"); // loading | ready | submitting | results | loadError
  const [hasApiKey, setHasApiKey] = useState(true);
  const [weight, setWeight] = useState("1000");
  const [cod, setCod] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const authedFetch = async (path, options = {}) => {
    const token = await auth.idToken();
    return fetch(`${APP_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch("/api/book-orders-bulk");
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || "Failed to load settings");

        setHasApiKey(json.settings.hasApiKey);
        setWeight(String(Math.round((json.settings.defaultWeight || 1) * 1000)));
        setInstructions(json.settings.defaultInstructions || "");
        setPhase("ready");
      } catch (e) {
        console.error("[instant-book-orders-bulk] load failed:", e.message);
        setPhase("loadError");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = async () => {
    setError(null);
    setPhase("submitting");
    try {
      const res = await authedFetch("/api/book-orders-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: orderGids, weight, cod, instructions }),
      });
      const json = await res.json();
      if (!json.ok && !("succeeded" in json)) {
        setError(json.error || "Booking failed.");
        setPhase("ready");
        return;
      }
      setResult(json);
      setPhase("results");
    } catch (e) {
      setError(e.message || "Booking failed.");
      setPhase("ready");
    }
  };

  if (phase === "loading") {
    return (
      <s-admin-action heading={i18n.translate("title")}>
        <s-stack direction="inline" alignItems="center" gap="small-200">
          <s-spinner accessibilityLabel="Loading" />
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => close()}>
          {i18n.translate("cancel")}
        </s-button>
      </s-admin-action>
    );
  }

  if (phase === "loadError") {
    return (
      <s-admin-action heading={i18n.translate("title")}>
        <s-banner tone="critical">{i18n.translate("loadError")}</s-banner>
        <s-button slot="secondary-actions" onClick={() => close()}>
          {i18n.translate("close")}
        </s-button>
      </s-admin-action>
    );
  }

  if (phase === "results") {
    const tone = result.failed > 0 ? "warning" : "success";
    const message = result.failed > 0 || result.skipped > 0
      ? i18n.translate("resultSummary", { succeeded: result.succeeded, skipped: result.skipped, failed: result.failed })
      : i18n.translate("resultAllSucceeded", { succeeded: result.succeeded });

    return (
      <s-admin-action heading={i18n.translate("title")}>
        <s-stack direction="block" gap="base">
          <s-banner tone={tone}>{message}</s-banner>
          {result.failures?.length > 0 && (
            <s-unordered-list>
              {result.failures.map((f, idx) => (
                <s-list-item key={idx}>{f.reason}</s-list-item>
              ))}
            </s-unordered-list>
          )}
        </s-stack>
        <s-button slot="primary-action" onClick={() => close()}>
          {i18n.translate("close")}
        </s-button>
      </s-admin-action>
    );
  }

  const submitting = phase === "submitting";

  return (
    <s-admin-action heading={i18n.translate("title")}>
      <s-stack direction="block" gap="base">
        {!hasApiKey && <s-banner tone="warning">{i18n.translate("notConfigured")}</s-banner>}
        {error && <s-banner tone="critical">{error}</s-banner>}

        <s-text type="strong">{i18n.translate("selectedCount", { count })}</s-text>

        <s-number-field
          label={i18n.translate("weightLabel")}
          details={i18n.translate("weightDetails")}
          value={weight}
          min="0"
          onInput={(e) => setWeight(e.currentTarget.value)}
        />
        <s-number-field
          label={i18n.translate("codLabel")}
          details={i18n.translate("codDetails")}
          value={cod}
          min="0"
          onInput={(e) => setCod(e.currentTarget.value)}
        />
        <s-text-area
          label={i18n.translate("instructionsLabel")}
          value={instructions}
          onInput={(e) => setInstructions(e.currentTarget.value)}
        />
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        loading={submitting}
        disabled={submitting || !hasApiKey}
        onClick={handleConfirm}
      >
        {submitting ? i18n.translate("booking") : i18n.translate("confirm", { count })}
      </s-button>
      <s-button slot="secondary-actions" disabled={submitting} onClick={() => close()}>
        {i18n.translate("cancel")}
      </s-button>
    </s-admin-action>
  );
}
