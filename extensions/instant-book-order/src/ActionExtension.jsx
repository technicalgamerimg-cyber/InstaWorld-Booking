import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

// Must match `application_url` in shopify.app.toml — extensions run on a
// Shopify-hosted origin and can't read the app's server env, so this is fixed here.
const APP_URL = "https://instant-bulk-booking.vercel.app";

export default async () => {
  render(<Extension />, document.body);
};

function defaultCod(order) {
  return order.financialStatus === "paid" ? "0" : (order.totalPrice || "0");
}

function findCityId(cities, cityName) {
  if (!cityName) return "";
  const match = cities.find((c) => c.name.toLowerCase() === cityName.trim().toLowerCase());
  return match ? String(match.id) : "";
}

// InstaWorld only recognizes exact names from its own city list — a free-typed
// city (typo, extra address text, a district it doesn't service) is the #1 cause
// of booking failures, so this forces a pick from that list instead of free text.
// A single search box: typing invalidates the current pick and shows matches
// below to tap; picking one fills the box with that exact name and closes the
// list. The list also closes on blur (delayed, so a tap on a match still
// registers first) — without this it stayed open indefinitely once you moved to
// another field without picking, pushing everything below it down the page.
//
// The field is deliberately UNCONTROLLED (defaultValue, not value): s-text-field
// is a custom element with its own internal value property, and re-asserting
// `value` on every render (a fully controlled field) fought with the user's own
// typing — confirmed live: after one edit, the box would freeze showing stale
// text no matter what was typed next. query still tracks what's typed (read from
// the input event) purely to compute matches; the DOM field itself is only ever
// written to imperatively, once, when a suggestion is picked.
function CitySelect({ cities, value, onChange, label }) {
  const selected = cities.find((c) => String(c.id) === String(value));
  const inputRef = useRef(null);
  const [query, setQuery] = useState(selected?.name || "");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef(null);

  useEffect(() => () => clearTimeout(blurTimer.current), []);

  const q = query.trim().toLowerCase();
  const matches = open && q ? cities.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8) : [];

  const clearBlurTimer = () => {
    clearTimeout(blurTimer.current);
    blurTimer.current = null;
  };

  const pick = (city) => {
    clearBlurTimer();
    onChange(String(city.id));
    setQuery(city.name);
    if (inputRef.current) inputRef.current.value = city.name;
    setOpen(false);
  };

  const handleInput = (e) => {
    const next = e.currentTarget.value;
    setQuery(next);
    setOpen(true);
    if (value) onChange("");
  };

  const handleFocus = () => {
    clearBlurTimer(); // a quick blur+refocus (e.g. tapping a result) must not let a pending close win
    setOpen(true);
  };

  const handleBlur = () => {
    blurTimer.current = setTimeout(() => setOpen(false), 200);
  };

  return (
    <s-stack direction="block" gap="small-200">
      <s-text-field
        ref={inputRef}
        label={label}
        placeholder="Type to search InstaWorld cities…"
        defaultValue={selected?.name || ""}
        onInput={handleInput}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {matches.length > 0 && (
        <s-stack direction="block" gap="small-100">
          {matches.map((c) => (
            <s-button key={c.id} variant="tertiary" onClick={() => pick(c)}>{c.name}</s-button>
          ))}
        </s-stack>
      )}
      {open && q && matches.length === 0 && (
        <s-text color="subdued">No matching city — keep typing or try a different spelling.</s-text>
      )}
    </s-stack>
  );
}

function Extension() {
  const { i18n, close, data, auth } = shopify;
  const orderGid = data.selected[0].id;

  const [phase, setPhase] = useState("loading"); // loading | ready | submitting | success | loadError
  const [order, setOrder] = useState(null);
  const [alreadyBooked, setAlreadyBooked] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [weight, setWeight] = useState("1000");
  const [cod, setCod] = useState(""); // blank = use Shopify's live outstanding amount at booking time
  const [instructions, setInstructions] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [cityId, setCityId] = useState("");
  const [cities, setCities] = useState([]);
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
        // Left blank deliberately — a stale DB-cached total sitting in this field
        // would be indistinguishable from a merchant's intentional override once
        // submitted. Blank means "use Shopify's live outstanding amount at booking
        // time" (see bookOrderWithLiveSync); lastKnownCod below is shown for
        // reference only.
        setInstructions(json.settings.defaultInstructions || "");
        setAddress(json.order.address || "");
        setPhone(json.order.phone || "");
        setCities(json.cities || []);
        setCityId(findCityId(json.cities || [], json.order.city));
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
        body: JSON.stringify({
          orderId: orderGid,
          weight,
          cod,
          instructions,
          address,
          phone,
          city: cities.find((c) => String(c.id) === String(cityId))?.name || "",
        }),
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
        <CitySelect cities={cities} value={cityId} onChange={setCityId} label={i18n.translate("cityLabel")} />

        <s-number-field
          label={i18n.translate("weightLabel")}
          value={weight}
          min="0"
          onInput={(e) => setWeight(e.currentTarget.value)}
        />
        <s-number-field
          label={i18n.translate("codLabel")}
          details={`Blank = Shopify's live amount (last synced: ${defaultCod(order)} ${order.currency || "PKR"})`}
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
        disabled={submitting || !hasApiKey || !cityId || !address.trim() || !phone.trim()}
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
