import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

// Must match `application_url` in shopify.app.toml — extensions run on a
// Shopify-hosted origin and can't read the app's server env, so this is fixed here.
const APP_URL = "https://instant-bulk-booking.vercel.app";

export default async () => {
  render(<Extension />, document.body);
};

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
// another order's field without picking, pushing everything below it down the page.
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
  const orderGids = data.selected.map((r) => r.id);

  const [phase, setPhase] = useState("loading"); // loading | ready | submitting | results | loadError
  const [orders, setOrders] = useState([]);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [courier, setCourier] = useState("Auto");
  const [availableCouriers, setAvailableCouriers] = useState([]);
  const [weight, setWeight] = useState("1000");
  const [cod, setCod] = useState("");
  const [instructions, setInstructions] = useState("");
  const [rows, setRows] = useState({}); // { [orderId]: { address, phone, cityId } }
  const [cities, setCities] = useState([]);
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
        const qs = orderGids.map((id) => `orderId=${encodeURIComponent(id)}`).join("&");
        const res = await authedFetch(`/api/book-orders-bulk?${qs}`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || "Failed to load orders");

        setOrders(json.orders);
        setHasApiKey(json.settings.hasApiKey);
        setAvailableCouriers(json.settings.availableCouriers || []);
        setCourier(json.settings.defaultCourier || "Auto");
        setWeight(String(Math.round((json.settings.defaultWeight || 1) * 1000)));
        setInstructions(json.settings.defaultInstructions || "");
        setCities(json.cities || []);
        setRows(Object.fromEntries(
          json.orders.map((o) => [o.id, {
            address: o.address || "",
            phone: o.phone || "",
            cityId: findCityId(json.cities || [], o.city),
          }])
        ));
        setPhase("ready");
      } catch (e) {
        console.error("[instant-book-orders-bulk] load failed:", e.message);
        setPhase("loadError");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bookable = orders.filter((o) => !o.alreadyBooked);
  const alreadyBookedCount = orders.length - bookable.length;
  const incompleteCount = bookable.filter((o) => {
    const r = rows[o.id];
    return !r?.cityId || !r?.address?.trim() || !r?.phone?.trim();
  }).length;

  const setRow = (id, key) => (e) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], [key]: e.currentTarget.value } }));
  const setRowCity = (id) => (cityId) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], cityId } }));

  const handleConfirm = async () => {
    setError(null);
    setPhase("submitting");
    try {
      const items = bookable.map((o) => ({
        orderId: o.id,
        address: rows[o.id]?.address,
        phone: rows[o.id]?.phone,
        city: cities.find((c) => String(c.id) === String(rows[o.id]?.cityId))?.name || "",
      }));
      const res = await authedFetch("/api/book-orders-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, weight, cod, courier, instructions }),
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

        <s-text type="strong">
          {alreadyBookedCount > 0
            ? i18n.translate("selectedCountWithSkipped", { count: bookable.length, skipped: alreadyBookedCount })
            : i18n.translate("selectedCount", { count: bookable.length })}
        </s-text>

        <s-stack direction="inline" gap="base">
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
        </s-stack>
        <s-select
          label={i18n.translate("courierLabel") || "Courier"}
          details={i18n.translate("courierDetails") || "Applied to every order in this batch"}
          value={courier}
          onInput={(e) => setCourier(e.currentTarget.value)}
        >
          <s-option value="Auto">Auto (InstaWorld Default)</s-option>
          {availableCouriers.map((c) => (
            <s-option key={c} value={c}>
              {c}
            </s-option>
          ))}
        </s-select>
        <s-text-area
          label={i18n.translate("instructionsLabel")}
          value={instructions}
          onInput={(e) => setInstructions(e.currentTarget.value)}
        />

        <s-text type="strong">{i18n.translate("reviewHeading")}</s-text>
        <s-stack direction="block" gap="base">
          {bookable.map((o) => (
            <s-box key={o.id} padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{o.name} — {o.customerName || "—"}</s-text>
                <s-stack direction="inline" gap="base">
                  <s-text-field
                    label={i18n.translate("addressLabel")}
                    value={rows[o.id]?.address ?? ""}
                    placeholder={o.city || ""}
                    onInput={setRow(o.id, "address")}
                  />
                  <s-text-field
                    label={i18n.translate("phoneLabel")}
                    value={rows[o.id]?.phone ?? ""}
                    onInput={setRow(o.id, "phone")}
                  />
                </s-stack>
                <CitySelect
                  cities={cities}
                  value={rows[o.id]?.cityId}
                  onChange={setRowCity(o.id)}
                  label={i18n.translate("cityLabel")}
                />
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        loading={submitting}
        disabled={submitting || !hasApiKey || bookable.length === 0 || incompleteCount > 0}
        onClick={handleConfirm}
      >
        {submitting
          ? i18n.translate("booking")
          : incompleteCount > 0
            ? i18n.translate("confirmMissingCity", { count: incompleteCount })
            : i18n.translate("confirm", { count: bookable.length })}
      </s-button>
      <s-button slot="secondary-actions" disabled={submitting} onClick={() => close()}>
        {i18n.translate("cancel")}
      </s-button>
    </s-admin-action>
  );
}
