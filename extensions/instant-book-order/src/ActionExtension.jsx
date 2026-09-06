import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Must match `application_url` in shopify.app.toml — extensions run on a
// Shopify-hosted origin and can't read the app's server env, so this is fixed here.
const APP_URL = "https://instant-bulk-booking.vercel.app";

export default async () => {
  render(<Extension />, document.body);
};

function defaultCod(order) {
  return order.financialStatus === "paid" ? "0" : (order.totalPrice || "0");
}

function Extension() {
  const { i18n, close, data, auth } = shopify;
  const orderGid = data.selected[0].id;

  const [phase, setPhase] = useState("loading"); // loading | ready | submitting | success | loadError
  const [order, setOrder] = useState(null);
  const [alreadyBooked, setAlreadyBooked] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [weight, setWeight] = useState("1000");
  const [cod, setCod] = useState("0");
  const [instructions, setInstructions] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState(null);
  const [trackingNumber, setTrackingNumber] = useState(null);

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
        const res = await authedFetch(`/api/book-order?orderId=${encodeURIComponent(orderGid)}`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || "Failed to load order");

        setOrder(json.order);
        setAlreadyBooked(json.alreadyBooked);
        setHasApiKey(json.settings.hasApiKey);
        setTrackingNumber(json.order.trackingNumber || null);
        setWeight(String(Math.round((json.settings.defaultWeight || 1) * 1000)));
        setCod(defaultCod(json.order));
        setInstructions(json.settings.defaultInstructions || "");
        setAddress(json.order.address || "");
        setPhone(json.order.phone || "");
        setPhase("ready");
      } catch (e) {
        console.error("[instant-book-order] load failed:", e.message);
        setPhase("loadError");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = async () => {
    setError(null);
    setPhase("submitting");
    try {
      const res = await authedFetch("/api/book-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderGid, weight, cod, instructions, address, phone }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || "Booking failed.");
        setPhase("ready");
        return;
      }
      setTrackingNumber(json.trackingNumber);
      setPhase("success");
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

  if (phase === "success") {
    return (
      <s-admin-action heading={i18n.translate("title")}>
        <s-banner tone="success">
          {i18n.translate("success", { trackingNumber })}
        </s-banner>
        <s-button slot="primary-action" onClick={() => close()}>
          {i18n.translate("close")}
        </s-button>
      </s-admin-action>
    );
  }

  if (alreadyBooked) {
    return (
      <s-admin-action heading={i18n.translate("title")}>
        <s-banner tone="info">
          {i18n.translate("alreadyBooked", { trackingNumber })}
        </s-banner>
        <s-button slot="secondary-actions" onClick={() => close()}>
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

        <s-text type="strong">
          {order.name} — {order.customerName || "—"}{order.city ? `, ${order.city}` : ""}
        </s-text>

        <s-text-field
          label={i18n.translate("addressLabel")}
          value={address}
          placeholder={order.city || ""}
          onInput={(e) => setAddress(e.currentTarget.value)}
        />
        <s-text-field
          label={i18n.translate("phoneLabel")}
          value={phone}
          onInput={(e) => setPhone(e.currentTarget.value)}
        />

        <s-number-field
          label={i18n.translate("weightLabel")}
          value={weight}
          min="0"
          onInput={(e) => setWeight(e.currentTarget.value)}
        />
        <s-number-field
          label={i18n.translate("codLabel")}
          value={cod}
          min="0"
          suffix={order.currency || "PKR"}
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
        {submitting ? i18n.translate("booking") : i18n.translate("confirm")}
      </s-button>
      <s-button slot="secondary-actions" disabled={submitting} onClick={() => close()}>
        {i18n.translate("cancel")}
      </s-button>
    </s-admin-action>
  );
}
