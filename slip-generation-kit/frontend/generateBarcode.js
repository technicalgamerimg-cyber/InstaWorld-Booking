// generateBarcode.js
//
// Calls the kit's backend `/api/barcode/:text` endpoint, which renders a
// Code-128 PNG using bwip-js, and returns a blob URL the PDF renderer can
// embed via <Image src=... />.
//
// Configure the API base URL via NEXT_PUBLIC_BARCODE_API_BASE_URL (Next.js)
// or VITE_BARCODE_API_BASE_URL (Vite) before bundling. Falls back to
// http://localhost:3004 for local dev.

const API_BASE_URL =
  (typeof process !== 'undefined' &&
    (process.env.NEXT_PUBLIC_BARCODE_API_BASE_URL ||
      process.env.VITE_BARCODE_API_BASE_URL)) ||
  'http://localhost:3004';

/**
 * Fetch a Code-128 barcode PNG and return a blob URL.
 *
 * @param {string|number} text   The string to encode.
 * @param {boolean} [includeText=true]  Render the human-readable text under
 *        the bars. Pass `false` for short barcodes where the text would
 *        overflow the cell.
 * @returns {Promise<string>}  A blob URL. Remember to `URL.revokeObjectURL`
 *          it later if you're generating many.
 */
export async function generateBarcode(text, includeText = true) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/barcode/${encodeURIComponent(String(text))}?includeText=${includeText}`
    );

    if (!response.ok) {
      throw new Error(`Barcode endpoint returned HTTP ${response.status}`);
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('generateBarcode failed:', err);
    throw err;
  }
}
