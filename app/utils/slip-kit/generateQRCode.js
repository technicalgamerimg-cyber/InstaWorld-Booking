import QRCode from "qrcode";

export async function generateQRCode(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: "H",
      type: "image/png",
      quality: 0.92,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (err) {
    console.error("generateQRCode failed:", err);
    return undefined;
  }
}
