// downloadLabels.js
//
// React-pdf cannot embed `blob:` URLs reliably across browsers and Safari in
// particular. Before handing label data to the renderer, we convert any blob
// URLs (barcodes from the backend endpoint) to base64 data URLs.
//
// Workflow:
//   1) Call mapShippingLabelData(...) — gives you an array of label objects.
//   2) Call downloadLabels(labels) — converts blobs, renders the PDF, saves.
//
// Install:
//   npm i @react-pdf/renderer file-saver

import { pdf } from '@react-pdf/renderer';
import { saveAs } from 'file-saver';
import React from 'react';
import LabelDocument from './LabelDocument.jsx';

/**
 * @param {Array} labels       Output of mapShippingLabelData.
 * @param {Object} [options]
 * @param {string} [options.filename='shipping-labels.pdf']
 * @returns {Promise<void>}
 */
export async function downloadLabels(labels, options = {}) {
  if (!labels || labels.length === 0) {
    throw new Error('No labels to download');
  }

  const filename = options.filename || `shipping-labels-${Date.now()}.pdf`;

  // Convert blob URLs (tracking_number, cod_amount, tcs_third_barcode) to base64.
  const prepared = await Promise.all(
    labels.map(async (label) => ({
      ...label,
      barcodes: {
        tracking_number:   await blobToBase64(label.barcodes?.tracking_number),
        cod_amount:        await blobToBase64(label.barcodes?.cod_amount),
        tcs_third_barcode: await blobToBase64(label.barcodes?.tcs_third_barcode),
      },
    }))
  );

  const blob = await pdf(<LabelDocument orders={prepared} />).toBlob();
  saveAs(blob, filename);
}

/**
 * Convert a `blob:` URL to a `data:` URL. Passes through `data:` and `http(s):`
 * URLs unchanged. Returns null on failure so the renderer can fall back.
 */
async function blobToBase64(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (!url.startsWith('blob:')) return url;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch blob');
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error('blobToBase64 failed for', url, err);
    return null;
  }
}
