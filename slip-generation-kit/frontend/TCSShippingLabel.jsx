// TCSShippingLabel.jsx
//
// TCS-style label: extra "consignee copy" barcode, ORGN/DSTN row, third
// barcode at the bottom. The data shape is identical to GenericLabel — the
// TCS-specific values (tcs_city_code, tcs_third_barcode) are populated by
// the TCS strategy in mapShippingLabelData.

'use client';
import React from 'react';
import { Document, Page, Text, View, StyleSheet, Font, Image } from '@react-pdf/renderer';

// Register fonts. If your target project blocks external fonts, drop this
// block and react-pdf will use its built-in Helvetica.
Font.register({
  family: 'Roboto',
  fonts: [
    { src: 'https://cdnjs.cloudflare.com/ajax/libs/ink/3.1.10/fonts/Roboto/roboto-light-webfont.ttf', fontWeight: 'normal' },
    { src: 'https://cdnjs.cloudflare.com/ajax/libs/ink/3.1.10/fonts/Roboto/roboto-bold-webfont.ttf',  fontWeight: 'bold' },
  ],
});

const LABEL_WIDTH = 595;
const LABEL_HEIGHT = 380;

const styles = StyleSheet.create({
  page: {
    width: LABEL_WIDTH,
    flexDirection: 'column',
    backgroundColor: 'white',
    padding: 10,
    height: '100%',
    fontFamily: 'Roboto',
    fontSize: 9,
  },
  section: { border: '1pt solid black', marginBottom: 5 },
  row: { flexDirection: 'row', borderBottom: '1pt solid black' },
  column: { flexDirection: 'column', flexGrow: 1, borderRight: '1pt solid black' },
  bold: { fontWeight: 'bold' },
  center: { alignItems: 'center', justifyContent: 'center' },
  borderBottom: { borderBottom: '1pt solid black' },
});

const TCSShippingLabel = ({ order }) => (
  <Page size={[LABEL_WIDTH, LABEL_HEIGHT]} style={styles.page}>
    <View style={styles.section}>
      {/* Header row: TCS logo • consignee tracking barcode • date/origin/dest • store logo */}
      <View style={styles.row}>
        <View style={[styles.column, { width: '25%', padding: 8 }]}>
          {order.courier_logo_url && (
            <Image src={order.courier_logo_url} style={{ height: 48, alignSelf: 'center' }} />
          )}
          <Text style={[styles.bold, { textAlign: 'center' }]}>TCS (Pvt) Ltd</Text>
        </View>

        <View style={[styles.column, styles.center, { width: '30%', padding: 8 }]}>
          {order.barcodes?.tracking_number && (
            <Image src={order.barcodes.tracking_number} style={{ width: 140, height: 50, alignSelf: 'center' }} />
          )}
          <Text style={[styles.bold, { textAlign: 'center' }]}>Consignee Copy</Text>
        </View>

        <View style={[styles.column, { width: '25%' }]}>
          <View style={[styles.row, styles.borderBottom]}>
            <Text style={[styles.bold, { width: '100%', padding: 8 }]}>
              Date: {new Date(order.fulfillment_date || Date.now()).toLocaleDateString()}
            </Text>
          </View>
          <View style={[styles.row, styles.borderBottom]}>
            <Text style={[styles.bold, { width: '100%', padding: 8 }]}>
              {order.service_type || 'Express'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.bold, { width: '100%', padding: 8 }]}>
              ORGN/DSTN: {order.shipper_details?.tcs_city_code || ''}/{order.destination_address?.tcs_city_code || ''}
            </Text>
          </View>
        </View>

        <View style={[styles.column, styles.center, { width: '20%', padding: 8 }]}>
          {order.store_logo_url && (
            <Image src={order.store_logo_url} style={{ width: 70, height: 70 }} />
          )}
        </View>
      </View>

      {/* Shipper / Consignee addresses */}
      <View style={styles.row}>
        <View style={[styles.column, { width: '40%', padding: 8 }]}>
          <Text style={styles.bold}>Shipper Address</Text>
          <Text style={{ marginBottom: 6 }}>{order.shipper_details?.address1}</Text>
          <Text>{order.shipper_details?.phone}</Text>
          <Text>{order.shipper_details?.email}</Text>
        </View>

        <View style={[styles.column, { width: '60%', padding: 8, borderRight: 0 }]}>
          <Text style={styles.bold}>Consignee Address</Text>
          <Text>{order.destination_address?.name}</Text>
          <Text style={{ marginBottom: 6 }}>
            {(order.destination_address?.address1 || '') + ' ' + (order.destination_address?.address2 || '')}
          </Text>
          <Text>{order.destination_address?.phone}</Text>
          <Text>{order.destination_address?.email || ''}</Text>
        </View>
      </View>

      {/* Pieces / Weight / COD strip */}
      <View style={styles.row}>
        <View style={[styles.column, { width: '40%' }]}>
          <View style={[styles.row, styles.borderBottom]}>
            <View style={{ width: '60%', borderRight: '1pt solid black' }}>
              <View style={[styles.row, styles.borderBottom]}>
                <Text style={{ width: '50%', padding: 4, borderRight: '1pt solid black' }}>Pieces</Text>
                <Text style={{ width: '50%', padding: 4 }}>{order.pieces || '1/1'}</Text>
              </View>
              <View style={{ height: 40, padding: 4 }}>
                <Text>Declared Insurance Value</Text>
              </View>
            </View>
            <View style={{ width: '40%' }}>
              <View style={[styles.row, styles.borderBottom]}>
                <Text style={{ width: '50%', padding: 4, borderRight: '1pt solid black' }}>Weight</Text>
                <Text style={{ width: '50%', padding: 4 }}>{order.weight ? `${order.weight}g` : '500g'}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={[styles.row, { width: '60%' }]}>
          <View style={[styles.column, { width: '30%' }]}>
            <View style={[styles.row, styles.borderBottom]}>
              <Text style={{ width: '50%', padding: 4, borderRight: '1pt solid black' }}>Fragile</Text>
              <Text style={{ width: '50%', padding: 4 }}>{order.fragile ? 'YES' : 'NO'}</Text>
            </View>
          </View>
          <View style={[styles.column, { width: '30%', padding: 8 }]}>
            <Text style={styles.bold}>COD AMOUNT</Text>
          </View>
          <View style={[styles.column, styles.center, { width: '40%', borderRight: 0 }]}>
            {order.barcodes?.cod_amount && (
              <Image src={order.barcodes.cod_amount} style={{ width: 100, height: 20 }} />
            )}
          </View>
        </View>
      </View>

      {/* Product Detail */}
      <View style={[styles.row, { width: '100%' }]}>
        <Text style={[styles.bold, { borderRight: '1pt solid black', width: '20%', padding: 2 }]}>
          Product Detail
        </Text>
        <Text style={{ width: '80%', padding: 2 }}>{order.product_details || 'No Product Details'}</Text>
      </View>

      {/* Remarks */}
      <View style={[styles.row, { width: '100%' }]}>
        <Text style={[styles.bold, { borderRight: '1pt solid black', width: '20%', padding: 2 }]}>
          Remarks
        </Text>
        <Text style={{ width: '80%', padding: 2 }}>{order.shipping_instructions}</Text>
      </View>

      {/* Footer row: QR • third barcode • order # • disclaimer */}
      <View style={styles.row}>
        <View style={[{ width: '10%' }]}>
          <View style={[styles.column, styles.center]}>
            {order.qr_codes?.details && (
              <Image src={order.qr_codes.details} style={{ width: 40, height: 40 }} />
            )}
          </View>
        </View>

        <View style={[{ width: '25%' }]}>
          <View style={[styles.column, styles.center, { padding: 8, width: '100%' }]}>
            {order.barcodes?.tcs_third_barcode && (
              <Image src={order.barcodes.tcs_third_barcode} style={{ width: 110, height: 40 }} />
            )}
          </View>
        </View>

        <View style={[{ width: '25%', backgroundColor: 'black' }]}>
          <View style={[styles.column, styles.center, { padding: 8, width: '100%' }]}>
            <Text style={[styles.bold, { color: 'white', fontSize: 20 }]}>{order.order_number}</Text>
          </View>
        </View>

        <View style={[{ width: '40%', padding: 4 }]}>
          <Text style={{ fontSize: 9 }}>
            Please don't accept if shipment is not intact. Before paying the COD,
            shipment cannot be opened. For complaints, contact{' '}
            {order.shipper_details?.name || ''} Ph: {order.shipper_details?.phone || ''}
          </Text>
        </View>
      </View>
    </View>
  </Page>
);

export default TCSShippingLabel;
