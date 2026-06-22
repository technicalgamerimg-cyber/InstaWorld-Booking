// generateQRCode.js
//
// Pure-frontend QR code generation using the `qrcode` npm package. Returns
// a base64 data URL ready to embed in the PDF via <Image src=... />.
//
// Install:  npm i qrcode

import QRCode from 'qrcode';

/**
 * @param {string} text  The payload to encode. Keep it under ~2.9KB; long
 *        strings force a denser QR with smaller modules and may not scan.
 * @returns {Promise<string|undefined>}  data URL (image/png) or undefined on
 *          error. Errors are logged, not thrown — callers can render a fallback.
 */
export async function generateQRCode(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      quality: 0.92,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (err) {
    console.error('generateQRCode failed:', err);
    return undefined;
  }
}
