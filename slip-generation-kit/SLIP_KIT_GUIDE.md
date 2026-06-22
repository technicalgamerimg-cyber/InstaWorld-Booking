# Shipping Slip Generation Kit — LCS, TCS (and any courier you add)

A drop-in kit that turns a booked order into a printable **PDF shipping label**
(a.k.a. "slip" / "consignee copy") for Leopards (LCS), TCS, and any other
Pakistani courier you wire up. Works after booking with the
[Courier Booking Kit](../courier-module-kit/COURIER_KIT_GUIDE.md) but is
independent of it — the only contract is the booked-order shape (described
below).

Built around a **strategy pattern**: one mapper turns booked-order data into a
flat label-data object, and one PDF document dispatches to a courier-specific
layout. Adding a courier = one new strategy entry + (optionally) one new layout
component.

---

## 🤖 Instructions for Claude (read this first)

You are being handed this kit to integrate into a project that has:

- An **Express** (or compatible) backend.
- A **React** frontend (Next.js / Vite / CRA all work).
- A booking flow that produces booked orders with tracking numbers.

Do the following:

1. **Copy the kit files** into the target project. Keep the `slip-generation-kit/`
   folder or move pieces wherever the project organises code (e.g. backend
   routes under `src/routes/`, frontend helpers under `src/lib/`). If you move
   files, update the relative imports.
2. **Mount the backend barcode route.** Add
   `app.use('/api/barcode', barcodeRoutes)` to the app entrypoint. Confirm the
   backend is ESM (`"type": "module"` in `package.json`). If it's CommonJS,
   convert the `import`/`export` to `require`/`module.exports`.
3. **Install the npm dependencies** (see **Dependencies** below).
4. **Configure the frontend API base URL** so `generateBarcode.js` can reach
   the new backend route (`NEXT_PUBLIC_BARCODE_API_BASE_URL` or
   `VITE_BARCODE_API_BASE_URL`).
5. **Verify the booked-order shape** the consumer will hand to the kit matches
   the contract in **Input shape** below. If the project's booking flow returns
   something different, write a small adapter — do **not** edit
   `mapShippingLabelData.js` to chase the project's idiosyncrasies; keep that
   file generic so future couriers stay easy to add.
6. **Wire it from the UI** (see **Usage** for the two-line consumer pattern).

Do **not** alter the label-data object shape or the strategy interface —
adding a courier should never require touching the mapper or the document
component, only adding a strategy + a layout.

---

## 📁 Files in this kit

```
slip-generation-kit/
├── SLIP_KIT_GUIDE.md                ← this file
├── backend/
│   └── barcode.routes.js            ← Express route: GET /api/barcode/:text  (bwip-js, Code-128)
└── frontend/
    ├── mapShippingLabelData.js      ← orders → flat label objects (the core)
    ├── generateBarcode.js           ← fetches the backend barcode PNG → blob URL
    ├── generateQRCode.js            ← qrcode npm → data URL
    ├── downloadLabels.js            ← blob→base64 + react-pdf → file-saver
    ├── LabelDocument.jsx            ← top-level Document; dispatches per courier
    └── TCSShippingLabel.jsx         ← TCS layout (consignee copy, third barcode)
```

**Requirements:** Node 18+ on the backend, modern React on the frontend,
ES modules everywhere.

---

## Dependencies

### Backend
```bash
npm i express bwip-js
```

### Frontend
```bash
npm i @react-pdf/renderer file-saver qrcode
```

`@react-pdf/renderer` is the largest dependency (~2 MB minified). If you only
ship labels from one route, lazy-load it:

```js
const { downloadLabels } = await import('@/slip-generation-kit/frontend/downloadLabels.js');
```

---

## Architecture

```
┌─────────────────────┐                       ┌──────────────────────┐
│  booked orders[]    │                       │   barcode endpoint   │
│  (post-booking)     │                       │   GET /api/barcode   │
└──────────┬──────────┘                       └──────────▲───────────┘
           │                                             │
           ▼                                             │ HTTP (PNG)
  ┌──────────────────────────┐         per fulfillment   │
  │ mapShippingLabelData()   ├─────────────────────────┐ │
  │                          │   generateBarcode() ────┘ │
  │  applies courier-specific├─►                         │
  │  barcode / QR strategies │   generateQRCode() ──────►│
  └──────────┬───────────────┘                           │
             │                                           │
             ▼                                           │
  ┌──────────────────────────┐                           │
  │  label data[]            │                           │
  │  (one per fulfillment)   │                           │
  └──────────┬───────────────┘                           │
             │                                           │
             ▼                                           │
  ┌──────────────────────────┐                           │
  │   downloadLabels()       │                           │
  │   - blob → base64        │                           │
  │   - react-pdf → blob     │                           │
  │   - file-saver           │                           │
  └──────────┬───────────────┘                           │
             ▼                                           │
       <LabelDocument>                                   │
         dispatch by courier_code                        │
         ├─► <TCSShippingLabel>  (TCS)                   │
         └─► <GenericLabel>      (LCS, default)          │
```

---

## Usage

The whole flow in two lines:

```js
import { mapShippingLabelData } from '@/slip-generation-kit/frontend/mapShippingLabelData';
import { downloadLabels }       from '@/slip-generation-kit/frontend/downloadLabels';

const labels = await mapShippingLabelData(bookedOrders, stores);
await downloadLabels(labels, { filename: 'orders-2026-05-24.pdf' });
```

If you want to preview before downloading, render `<LabelDocument orders={labels} />`
inside `<PDFViewer>` from `@react-pdf/renderer`.

---

## Input shape

Each entry in the `orders` array passed to `mapShippingLabelData` must look
like this. The shape is intentionally close to what the
[Courier Booking Kit](../courier-module-kit/COURIER_KIT_GUIDE.md) produces
post-booking — write an adapter if your booking flow differs.

```jsonc
{
  "id": "order_cuid",
  "order_number": "#1024",
  "store_id": "store_cuid",

  "shipping_address": {
    "name": "Jane Doe",
    "first_name": "Jane",
    "last_name":  "Doe",
    "address1": "House 42, St 5",
    "address2": "Block B",
    "city":     "Karachi",
    "country":  "Pakistan",
    "phone":    "+923001234567",
    "email":    "jane@example.com",
    "zip":      "75500",
    "province": "Sindh",
    "company":  null
  },

  "order_items": [
    {
      "variant_id":  "var_123",
      "sku":         "TSHIRT-RED-M",
      "name":        "Red T-Shirt (M)",
      "image_url":   "https://...",
      "unit_price":  1500,
      "total_price": 1500,
      "weight":      0.2,
      "weight_unit": "kg",
      "requires_shipping": true
    }
  ],

  "fulfillment_orders": [
    {
      "fulfillment_order_id": "fo_123",
      "tracking_number": "HD75XXXXX",         // populated from booking response
      "cod_amount": "1500",                   // string or number, in PKR
      "fulfilment_date": "2026-05-24T08:00:00Z",   // optional
      "line_items": [
        {
          "fulfillment_order_line_item_id": "foli_123",
          "line_item_id": "li_123",
          "variant_id":   "var_123",
          "fulfillment_order_quantity": 1
        }
      ]
    }
  ],

  "selectedCourierCity": {
    "courier_city_id": "1234",
    "services_available": ["OVERNIGHT", "OVERLAND"],
    "meta_data": {
      "cityName": "KARACHI",     // TCS uses cityName
      "cityCode": "KHI",         // TCS uses cityCode
      "name":     "Karachi",     // LCS uses name
      "cityID":   2494           // TCS uses cityID for QR payload
    }
  },

  "courierAccount": {
    "courier": { "name": "TCS" },             // "LCS" | "TCS" | <custom>
    "metadata": {
      "shipper_details": {
        "name":    "Acme Store",
        "address": "Plot 1, Industrial Area",
        "phone":   "+92211111111",
        "email":   "ship@acme.pk",
        "city":    "Karachi",
        "default_remarks": "Handle with care",
        "tcs_origin": {                       // TCS-only nested block
          "tcs_account": "704576",
          "cityName":    "KARACHI",
          "cityCode":    "KHI",
          "cityID":      2494,
          "cost_center_code": "034"
        }
      }
    }
  }
}
```

And the `stores` array:
```jsonc
[ { "id": "store_cuid", "logo_url": "https://..." } ]
```

---

## Output (label data) shape

`mapShippingLabelData` returns a **flat** array — one entry per fulfillment
(so a 2-fulfillment order produces 2 entries). The Document component consumes
this directly.

```jsonc
{
  "courier_code":      "TCS",
  "courier_logo_url":  "...",
  "store_logo_url":    "...",
  "tracking_number":   "HD75XXXXX",
  "order_number":      "#1024",
  "fulfillment_date":  "2026-05-24T08:00:00Z",
  "service_type":      "OVERNIGHT",
  "cod_amount":        1500,
  "pieces":            "1/2",
  "weight":            200,                    // grams
  "fragile":           false,
  "product_details":   "TSHIRT-RED-M x 1",
  "shipping_instructions": "Handle with care",
  "special_shipper_remarks": "",

  "barcodes": {
    "tracking_number":   "blob:...",           // becomes data: after downloadLabels
    "cod_amount":        "blob:...",
    "tcs_third_barcode": "blob:..."            // TCS only; null otherwise
  },
  "qr_codes": {
    "details": "data:image/png;base64,..."
  },

  "destination_address": { /* normalized */ },
  "shipper_details":     { /* normalized */ }
}
```

---

## Customising for your project

### Provide a courier-logo resolver

If you have a registry of courier logos, pass it as an option so labels show
the right brand:

```js
import { getCourierLogo } from '@/lib/courier-logos';

await mapShippingLabelData(orders, stores, { getCourierLogo });
```

`getCourierLogo` receives the courier name (e.g. `"LCS"`) and returns a URL.

### Adding a new courier

1. **Strategy** — add an entry to `barcodeStrategies` in `mapShippingLabelData.js`:
   ```js
   MYCOURIER: ({ fulfillment, courierCity, cod_str }) => ({
     codBarcodeText: cod_str || '0',
     codBarcodeWithText: false,
     qrPayload: `${fulfillment.tracking_number}|${courierCity?.courier_city_id}|${cod_str}`,
     extraBarcodeText: null,         // or a string if your slip needs a third barcode
   }),
   ```
   The returned object's shape is fixed; only the values differ per courier.

2. **(Optional) Layout** — if MyCourier's slip looks meaningfully different,
   add a new component (mirror `TCSShippingLabel.jsx`) and dispatch in
   `LabelDocument.jsx`:
   ```js
   if (courier === 'mycourier') return <MyCourierLabel key={key} order={order} />;
   ```
   If MyCourier is happy with the generic layout, you can skip this step.

That's it. No edits to the data mapper signature, no edits to `downloadLabels`.

### Different label dimensions

The generic label is sized 595×380pt (~4"×6"). Edit the `LABEL_WIDTH` /
`LABEL_HEIGHT` constants in `LabelDocument.jsx` to match your thermal
printer's roll. Same constants exist in `TCSShippingLabel.jsx` — keep them
in sync.

---

## Caveats / gotchas

- **`@react-pdf/renderer` cannot embed `blob:` URLs reliably across browsers**
  (especially Safari). Always go through `downloadLabels` — it converts blobs
  to base64 first. If you bypass it and render the `<LabelDocument>` directly,
  do the conversion yourself.
- **Barcode endpoint URLs leak the encoded value.** The endpoint is unauthed
  and the path contains the tracking number. Don't put it behind a public CDN
  if your tracking IDs are sensitive — proxy via your own domain or move the
  endpoint behind auth.
- **Fonts.** `TCSShippingLabel.jsx` loads Roboto from a CDN. If your target
  project blocks external network requests at render time, delete the
  `Font.register(...)` block — react-pdf will fall back to its built-in
  Helvetica.
- **TCS `tcs_origin` is required.** The TCS strategy reads `shipperDetails.tcs_origin.cityID`
  and `.cityCode` for the QR/extra-barcode payloads. If those are missing, the
  QR will encode `""` in their slots and TCS scanners will treat the parcel as
  malformed. Fail loud upstream when adding a TCS shipper.
- **No pagination check.** If you book 500 orders at once, react-pdf builds a
  500-page document in memory. Chunk client-side if you regularly exceed ~100.

---

## Underlying packages (reference)

| Package | What it does in the kit |
|---|---|
| `bwip-js`           | Code-128 PNG rendering on the backend |
| `qrcode`            | QR code PNG (as data URL) on the frontend |
| `@react-pdf/renderer` | PDF document, pages, layout primitives |
| `file-saver`        | Triggers the browser "save as" prompt |
