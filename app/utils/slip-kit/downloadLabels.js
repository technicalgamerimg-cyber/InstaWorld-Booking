import { pdf } from "@react-pdf/renderer";
import { saveAs } from "file-saver";
import React from "react";
import LabelDocument from "./LabelDocument.jsx";

export async function downloadLabels(labels, options = {}) {
  if (!labels || labels.length === 0) {
    throw new Error("No labels to download");
  }

  const filename = options.filename || `shipping-labels-${Date.now()}.pdf`;

  const prepared = await Promise.all(
    labels.map(async (label) => ({
      ...label,
      barcodes: {
        tracking_number: await blobToBase64(label.barcodes?.tracking_number),
        cod_amount: await blobToBase64(label.barcodes?.cod_amount),
        tcs_third_barcode: await blobToBase64(label.barcodes?.tcs_third_barcode),
      },
    }))
  );

  const blob = await pdf(<LabelDocument orders={prepared} />).toBlob();
  saveAs(blob, filename);
}

async function blobToBase64(url) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (!url.startsWith("blob:")) return url;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch blob");
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error("blobToBase64 failed for", url, err);
    return null;
  }
}
