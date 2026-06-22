export function adaptOrderForSlipKit(order, settings) {
  const nameParts = (order.customerName || "Customer").split(" ");
  const codAmount =
    order.financialStatus === "paid"
      ? 0
      : parseFloat(order.totalPrice || "0");

  return {
    id: order.id,
    order_number: (order.name || String(order.id)).replace("#", ""),
    store_id: null,
    shipping_address: {
      name: order.customerName || "",
      first_name: nameParts[0] || "",
      last_name: nameParts.slice(1).join(" ") || "",
      address1: order.address || "",
      address2: "",
      city: order.city || "",
      phone: order.phone || "",
      email: order.email || "",
      zip: "",
      province: "",
      country: "Pakistan",
      company: "",
    },
    order_items: [
      {
        variant_id: null,
        sku: "",
        name: "Shipment",
        image_url: "",
        unit_price: parseFloat(order.totalPrice || "0"),
        total_price: parseFloat(order.totalPrice || "0"),
        quantity: 1,
        weight: settings?.defaultWeight ?? 1,
        weight_unit: "kg",
        requires_shipping: true,
      },
    ],
    fulfillment_orders: [
      {
        fulfillment_order_id: null,
        tracking_number: order.trackingNumber || "",
        cod_amount: codAmount,
        fulfilment_date: order.createdAt,
        line_items: [],
      },
    ],
    // No city codes available — kit falls back to DEFAULT barcode strategy
    selectedCourierCity: {
      courier_city_id: null,
      meta_data: {
        cityName: order.city || "",
        cityCode: "",
        cityID: "",
        name: order.city || "",
      },
    },
    courierAccount: {
      courier: { name: order.courierName || "InstaWorld" },
      metadata: {
        shipper_details: {
          name: settings?.shipperName || "",
          address: settings?.shipperAddress || "",
          city: settings?.shipperCity || "",
          phone: settings?.shipperPhone || "",
          email: "",
          tcs_origin: { cityCode: "", cityID: "" },
          default_remarks: settings?.defaultInstructions || "",
        },
      },
    },
  };
}
