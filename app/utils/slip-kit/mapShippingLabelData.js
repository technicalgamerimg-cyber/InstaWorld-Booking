import { generateBarcode } from "./generateBarcode.js";
import { generateQRCode } from "./generateQRCode.js";

export async function mapShippingLabelData(orders, stores, options = {}) {
  const getCourierLogo = options.getCourierLogo || (() => "");

  const labelsArrays = await Promise.all(
    orders.map(async (order) => {
      const courierAccount = order.courierAccount;
      const courier = courierAccount?.courier || {};
      const courierName = (courier.name || "").toUpperCase();
      const courierCity = order.selectedCourierCity;
      const shipperDetails = courierAccount?.metadata?.shipper_details || {};
      const store = stores.find((s) => s.id === order.store_id) || {};

      const fulfillmentOrders = order.fulfillment_orders || [];

      const orderLabels = await Promise.all(
        fulfillmentOrders.map(async (fulfillment, idx) => {
          const shipmentItems = buildShipmentItems(fulfillment, order.order_items || []);

          const cod_str = String(fulfillment.cod_amount ?? 0);
          const productDetails = shipmentItems
            .map((item) => `${item.sku} x ${item.quantity || 0}`)
            .join(", ");

          const totalWeightGrams = shipmentItems.reduce((total, item) => {
            let perUnit = parseFloat(item.weight || 0);
            if (item.weight_unit === "kg") perUnit *= 1000;
            return total + perUnit * (item.quantity || 0);
          }, 0);

          const strategy = barcodeStrategies[courierName] || barcodeStrategies.DEFAULT;
          const { codBarcodeText, codBarcodeWithText, qrPayload, extraBarcodeText } = strategy({
            fulfillment,
            order,
            courierCity,
            shipperDetails,
            cod_str,
          });

          const [tracking_number_barcode, cod_amount_barcode, qr_code, extra_barcode] =
            await Promise.all([
              generateBarcode(fulfillment.tracking_number || ""),
              generateBarcode(codBarcodeText, codBarcodeWithText),
              generateQRCode(qrPayload),
              extraBarcodeText ? generateBarcode(extraBarcodeText, false) : Promise.resolve(null),
            ]);

          return {
            courier_code: courier.name || "",
            courier_logo_url: getCourierLogo(courier.name) || "",
            store_logo_url: store?.logo_url || "",
            tracking_number: fulfillment.tracking_number || "",
            order_number: order.order_number || "",
            fulfillment_date: fulfillment.fulfilment_date || new Date().toISOString(),
            service_type: courierCity?.services_available?.[0] || "",
            cod_amount: parseFloat(fulfillment.cod_amount || 0),
            pieces: `${idx + 1}/${fulfillmentOrders.length}`,
            weight: totalWeightGrams,
            fragile: false,
            product_details: productDetails,
            shipping_instructions: shipperDetails.default_remarks || "",
            special_shipper_remarks: "",
            barcodes: {
              tracking_number: tracking_number_barcode,
              cod_amount: cod_amount_barcode,
              tcs_third_barcode: extra_barcode,
            },
            qr_codes: { details: qr_code },
            destination_address: {
              name: order.shipping_address?.name || "",
              first_name: order.shipping_address?.first_name || "",
              last_name: order.shipping_address?.last_name || "",
              address1: order.shipping_address?.address1 || "",
              address2: order.shipping_address?.address2 || "",
              city: resolveDestinationCity(courierName, courierCity, order.shipping_address),
              tcs_city_code: courierCity?.meta_data?.cityCode || "",
              zip: order.shipping_address?.zip || "",
              province: order.shipping_address?.province || "",
              country: order.shipping_address?.country || "",
              phone: order.shipping_address?.phone || "",
              email: order.shipping_address?.email || "",
              company: order.shipping_address?.company || "",
            },
            shipper_details: {
              name: shipperDetails.name || "",
              address1: shipperDetails.address || "",
              address2: "",
              city: shipperDetails.city || "",
              tcs_city_code: shipperDetails.tcs_origin?.cityCode || "",
              country: "Pakistan",
              province: "",
              zip: "",
              phone: shipperDetails.phone || "",
              email: shipperDetails.email || "",
              first_name: "",
              last_name: "",
              company: "",
            },
          };
        })
      );

      return orderLabels;
    })
  );

  return labelsArrays.flat();
}

function buildShipmentItems(fulfillment, orderItems) {
  return (fulfillment.line_items || [])
    .map((line) => {
      const item = orderItems.find((oi) => oi.variant_id === line.variant_id);
      if (!item) return null;
      return {
        fulfillment_order_line_item_id: line.fulfillment_order_line_item_id,
        line_item_id: line.line_item_id,
        variant_id: line.variant_id,
        quantity: line.fulfillment_order_quantity,
        name: item.name,
        sku: item.sku,
        image_url: item.image_url,
        unit_price: item.unit_price,
        total_price: item.total_price,
        weight: item.weight,
        weight_unit: item.weight_unit,
        requires_shipping: item.requires_shipping,
      };
    })
    .filter(Boolean);
}

function resolveDestinationCity(courierName, courierCity, shippingAddress) {
  if (courierName === "TCS") return courierCity?.meta_data?.cityName || shippingAddress?.city || "";
  if (courierName === "LCS") return courierCity?.meta_data?.name || shippingAddress?.city || "";
  return shippingAddress?.city || "";
}

function base64EncodeUnicode(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  const latin1 = String.fromCharCode(...utf8Bytes);
  return btoa(latin1);
}

const barcodeStrategies = {
  LCS: ({ fulfillment, courierCity, cod_str }) => ({
    codBarcodeText: cod_str || "0",
    codBarcodeWithText: false,
    qrPayload: `${fulfillment.tracking_number},${courierCity?.courier_city_id || null},${cod_str}.00`,
    extraBarcodeText: null,
  }),

  TCS: ({ fulfillment, order, courierCity, shipperDetails, cod_str }) => {
    const codText = `RS${cod_str}`;
    const qrInnerPayload = [
      fulfillment.tracking_number,
      `${shipperDetails.tcs_origin?.cityID || ""}${courierCity?.courier_city_id || ""}`,
      cod_str,
      "O",
      order.shipping_address?.name || "",
      `${(order.shipping_address?.address1 || "").trim()},${courierCity?.meta_data?.cityName || ""}`,
      order.shipping_address?.phone || "",
    ].join("|");
    const encoded = base64EncodeUnicode(qrInnerPayload);
    return {
      codBarcodeText: codText,
      codBarcodeWithText: true,
      qrPayload: `${fulfillment.tracking_number}-${courierCity?.meta_data?.cityCode || ""}${courierCity?.courier_city_id || ""}-${cod_str}-${encoded}`,
      extraBarcodeText: `${fulfillment.tracking_number}-${shipperDetails.tcs_origin?.cityCode || ""}${courierCity?.meta_data?.cityCode || ""}-${cod_str}`,
    };
  },

  DEFAULT: ({ fulfillment, courierCity, cod_str }) => ({
    codBarcodeText: cod_str || "0",
    codBarcodeWithText: false,
    qrPayload: `${fulfillment.tracking_number},${courierCity?.courier_city_id || null},${cod_str}`,
    extraBarcodeText: null,
  }),
};
