// generateBarcode.js — patched for Remix/Vite (uses relative /api/barcode/... path)

const API_BASE =
  typeof import.meta !== "undefined"
    ? (import.meta.env?.VITE_BARCODE_API_BASE_URL ?? "")
    : "";

export async function generateBarcode(text, includeText = true) {
  try {
    const response = await fetch(
      `${API_BASE}/api/barcode/${encodeURIComponent(String(text))}?includeText=${includeText}`
    );
    if (!response.ok) {
      throw new Error(`Barcode endpoint returned HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error("generateBarcode failed:", err);
    throw err;
  }
}
