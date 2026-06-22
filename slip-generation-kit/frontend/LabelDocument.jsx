// LabelDocument.jsx
//
// The top-level PDF document. Walks the label array and dispatches to a
// courier-specific layout when one exists; otherwise renders the generic
// 4"x6" layout.
//
// Add a new courier layout by importing it and adding a case to renderLabel().
//
// Install:  npm i @react-pdf/renderer

import React from 'react';
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import TCSShippingLabel from './TCSShippingLabel.jsx';

const LABEL_WIDTH = 595.28;  // A4 width in points (210mm)
const LABEL_HEIGHT = 380;    // ~half-A4 height; suits a 4"x6" label

const styles = StyleSheet.create({
  page: { padding: 0, margin: 0 },
  container: { width: '100%', height: '100%', padding: 0, margin: 0 },
  label: {
    width: '100%', height: '100%',
    borderWidth: 1, borderColor: 'black',
    padding: 4, backgroundColor: 'white',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  image: { height: 60, objectFit: 'contain', margin: 4 },
  courierimage: { width: 100, height: 60, objectFit: 'contain', margin: 4 },
  barcode: { height: 40, width: 160, objectFit: 'contain', margin: 2 },
  qrCode: { height: 100, width: 100, objectFit: 'contain', padding: 2 },
  boldText: { fontSize: 12, fontWeight: 'bold', textAlign: 'center' },
  smallText: { fontSize: 10, textAlign: 'left' },
  smallestText: { fontSize: 8, textAlign: 'left' },
  mediumText: { fontSize: 11, fontWeight: 'bold' },
  serviceText: { fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
  cityText: { fontSize: 12, fontWeight: 'bold', textAlign: 'left' },
  Pprice: { fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  Pricebarcode: { height: 25, width: 80, objectFit: 'contain', alignSelf: 'center', margin: 2 },
  borderBottom: { borderBottomWidth: 1, borderBottomColor: 'black' },
  borderTop: { borderTopWidth: 1, borderTopColor: 'black' },
  borderRight: { borderRightWidth: 1, borderRightColor: 'black' },
  border: { borderWidth: 1, borderColor: 'black' },
  blackBg: { backgroundColor: 'black' },
  whiteText: { color: 'white' },
});

const LabelDocument = ({ orders }) => {
  if (!orders || orders.length === 0) {
    return (
      <Document>
        <Page size={[LABEL_WIDTH, LABEL_HEIGHT]} style={styles.page}>
          <View style={styles.container}>
            <Text style={styles.boldText}>No orders to display</Text>
          </View>
        </Page>
      </Document>
    );
  }

  return (
    <Document>
      {orders.map((order, index) => renderLabel(order, index))}
    </Document>
  );
};

function renderLabel(order, index) {
  const key = `label-${index}-${order.tracking_number || index}`;
  const courier = (order.courier_code || '').toLowerCase();

  if (courier === 'tcs') return <TCSShippingLabel key={key} order={order} />;

  return <GenericLabel key={key} order={order} />;
}

// ---------------------------------------------------------------------------
// Generic LCS-style label (works for LCS and any other courier without its
// own layout). Three columns: address, notes/product, QR + COD.
// ---------------------------------------------------------------------------
function GenericLabel({ order }) {
  return (
    <Page size={[LABEL_WIDTH, LABEL_HEIGHT]} style={styles.page}>
      <View style={styles.container}>
        <View style={styles.label}>
          {/* Header */}
          <View style={[styles.row, { paddingVertical: 4, height: 80 }]}>
            <View style={{ width: '33%', alignItems: 'center', justifyContent: 'center' }}>
              {order.store_logo_url && <Image style={styles.image} src={order.store_logo_url} />}
            </View>
            <View style={{ width: '34%', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={styles.serviceText}>
                {order.service_type?.toUpperCase() || 'STANDARD'}
              </Text>
              <Text style={[styles.smallText, { marginTop: 2 }]}>
                {order.cod_amount > 0 ? 'COD' : 'NON-COD'}
              </Text>
              {order.barcodes?.tracking_number && (
                <Image style={styles.barcode} src={order.barcodes.tracking_number} />
              )}
            </View>
            <View style={{ width: '33%', alignItems: 'center', justifyContent: 'center' }}>
              {order.courier_logo_url && (
                <Image style={styles.courierimage} src={order.courier_logo_url} />
              )}
            </View>
          </View>

          {/* Body */}
          <View style={[styles.border, { flexDirection: 'row', flex: 1 }]}>
            {/* Left: addresses */}
            <View style={[styles.borderRight, { width: '45%', flexDirection: 'column', justifyContent: 'space-between' }]}>
              <View style={{ flex: 1 }}>
                <View style={[styles.borderBottom, { paddingVertical: 4 }]}>
                  <Text style={styles.boldText}>Receiver Information</Text>
                </View>
                <View style={{ padding: 4 }}>
                  <Text style={styles.mediumText}>
                    {order.destination_address?.first_name} {order.destination_address?.last_name}
                  </Text>
                  <Text style={[styles.smallText, { marginTop: 2 }]}>
                    {order.destination_address?.address1}
                  </Text>
                  {order.destination_address?.address2 && (
                    <Text style={styles.smallText}>{order.destination_address.address2}</Text>
                  )}
                  <Text style={[styles.smallText, { marginTop: 2 }]}>
                    {order.destination_address?.phone}
                  </Text>
                </View>
                <View style={{ backgroundColor: 'black', width: '100%', paddingVertical: 4, paddingHorizontal: 4 }}>
                  <Text style={[styles.cityText, { color: 'white' }]}>
                    Destination: {order.destination_address?.city?.toUpperCase()}
                  </Text>
                </View>
              </View>
              <View>
                <View style={[styles.borderTop, styles.borderBottom, { paddingVertical: 4 }]}>
                  <Text style={styles.boldText}>Shipper Information</Text>
                </View>
                <View style={{ padding: 4 }}>
                  <Text style={styles.smallText}>{order.shipper_details?.name}</Text>
                  <Text style={[styles.smallText, { marginTop: 2 }]}>{order.shipper_details?.address1}</Text>
                  <Text style={[styles.smallText, { marginTop: 2 }]}>{order.shipper_details?.phone}</Text>
                </View>
              </View>
            </View>

            {/* Middle: notes & product */}
            <View style={[styles.borderRight, { width: '27.5%', flexDirection: 'column', justifyContent: 'space-between' }]}>
              <View style={{ flex: 1 }}>
                {order.shipping_instructions?.trim() && (
                  <View>
                    <View style={[styles.borderBottom, { paddingVertical: 2, paddingHorizontal: 2 }]}>
                      <Text style={styles.mediumText}>Customer Notes:</Text>
                    </View>
                    <View style={{ paddingHorizontal: 2, paddingVertical: 2 }}>
                      <Text style={styles.smallestText}>{order.shipping_instructions}</Text>
                    </View>
                  </View>
                )}
                {order.product_details && (
                  <View>
                    <View style={[styles.borderBottom, styles.borderTop, { paddingVertical: 2, paddingHorizontal: 2 }]}>
                      <Text style={styles.mediumText}>Product Details:</Text>
                    </View>
                    <View style={{ paddingHorizontal: 2, paddingVertical: 2 }}>
                      <Text style={styles.smallestText}>{order.product_details}</Text>
                    </View>
                  </View>
                )}
              </View>
              <View style={[styles.blackBg, { paddingVertical: 8, justifyContent: 'center', alignItems: 'center' }]}>
                <Text style={[styles.mediumText, styles.whiteText]}>{order.order_number}</Text>
              </View>
            </View>

            {/* Right: QR + COD */}
            <View style={{ width: '27.5%', flexDirection: 'column', justifyContent: 'space-between' }}>
              {order.qr_codes?.details && (
                <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                  <Image style={styles.qrCode} src={order.qr_codes.details} />
                </View>
              )}
              <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                <Text style={[styles.smallText, { marginBottom: 2 }]}>Tracking: {order.tracking_number}</Text>
                <Text style={[styles.smallText, { marginBottom: 2 }]}>Pieces: {order.pieces || '1/1'}</Text>
                <Text style={[styles.smallText, { marginBottom: 2 }]}>Weight: {order.weight ? `${order.weight}g` : '500g'}</Text>
                <Text style={styles.smallText}>
                  Date: {new Date(order.fulfillment_date || Date.now()).toLocaleDateString()}
                </Text>
              </View>
              <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                {order.barcodes?.cod_amount && (
                  <Image style={styles.Pricebarcode} src={order.barcodes.cod_amount} />
                )}
                <Text style={styles.Pprice}>RS {order.cod_amount}</Text>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Page>
  );
}

export default LabelDocument;
