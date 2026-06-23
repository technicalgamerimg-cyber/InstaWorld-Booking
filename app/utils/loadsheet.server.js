import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fs from "fs";
import path from "path";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const TABLE_W = PAGE_W - MARGIN * 2; // 515
const ROW_H = 28;
const FONT_SIZE = 9;
const FOOTER_RESERVE = 90;

const BLACK = rgb(0, 0, 0);
const GREY_HEADER_BG = rgb(0.91, 0.91, 0.91);
const GREY_ALT_BG = rgb(0.975, 0.975, 0.975);
const GREY_BORDER = rgb(0.78, 0.78, 0.78);
const GREY_TEXT = rgb(0.43, 0.44, 0.46);

const COLS = [
  { label: "#",              width: 22  },
  { label: "Shipment No",    width: 105 },
  { label: "Send date",      width: 68  },
  { label: "Recipient",      width: 80  },
  { label: "Delivery point", width: 68  },
  { label: "Order Ref",      width: 52  },
  { label: "Qty",            width: 22  },
  { label: "COD Amt",        width: 58  },
  { label: "Type",           width: 40  },
];
// Total = 515 = TABLE_W

const COL_X = [];
let _cx = MARGIN;
for (const col of COLS) { COL_X.push(_cx); _cx += col.width; }

// Word-based truncation with ellipsis
function truncate(text, font, size, maxPt) {
  const s = String(text || "");
  if (font.widthOfTextAtSize(s, size) <= maxPt) return s;
  const words = s.split(" ");
  let result = "";
  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word;
    if (font.widthOfTextAtSize(`${candidate}…`, size) <= maxPt) {
      result = candidate;
    } else {
      if (!result) {
        // Single word too long — char-truncate
        let chars = word;
        while (chars.length > 1 && font.widthOfTextAtSize(`${chars}…`, size) > maxPt) {
          chars = chars.slice(0, -1);
        }
        result = chars;
      }
      break;
    }
  }
  return `${result}…`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  // "21 Jun 08:18" — ~60pt at 9pt, fits in 68pt column
  return `${d.getDate()} ${months[d.getMonth()]} ${h}:${m}`;
}

function drawColumnDividers(page, top, bottom) {
  let dx = MARGIN;
  for (let i = 0; i < COLS.length - 1; i++) {
    dx += COLS[i].width;
    page.drawLine({ start: { x: dx, y: top }, end: { x: dx, y: bottom }, thickness: 0.4, color: GREY_BORDER });
  }
  // Outer vertical borders
  page.drawLine({ start: { x: MARGIN, y: top }, end: { x: MARGIN, y: bottom }, thickness: 0.7, color: GREY_BORDER });
  page.drawLine({ start: { x: MARGIN + TABLE_W, y: top }, end: { x: MARGIN + TABLE_W, y: bottom }, thickness: 0.7, color: GREY_BORDER });
}

function drawSenderHeader(page, settings, logoImage, fonts) {
  const { font, fontBold } = fonts;
  let y = PAGE_H - MARGIN;

  // Logo top-right
  if (logoImage) {
    const { width: lw, height: lh } = logoImage.scaleToFit(120, 45);
    page.drawImage(logoImage, {
      x: PAGE_W - MARGIN - lw,
      y: PAGE_H - MARGIN - lh,
      width: lw,
      height: lh,
    });
  }

  // Shop name bold
  const shopName = settings?.shipperName || "";
  if (shopName) {
    page.drawText(shopName, { x: MARGIN, y: y - 14, size: 13, font: fontBold, color: BLACK });
  }
  y -= 20;

  if (settings?.shipperPhone) {
    page.drawText(`Phone: ${settings.shipperPhone}`, { x: MARGIN, y: y - 11, size: 10, font, color: BLACK });
    y -= 16;
  }

  if (settings?.shipperAddress) {
    const addr = truncate(`Sender: ${settings.shipperAddress}`, font, 10, TABLE_W);
    page.drawText(addr, { x: MARGIN, y: y - 11, size: 10, font, color: BLACK });
    y -= 16;
  }

  return y - 8; // y position where table starts
}

function drawTableHeader(page, y, fonts) {
  const { fontBold } = fonts;
  const top = y;
  const bottom = y - ROW_H;

  page.drawRectangle({ x: MARGIN, y: bottom, width: TABLE_W, height: ROW_H, color: GREY_HEADER_BG });

  for (let i = 0; i < COLS.length; i++) {
    const label = truncate(COLS[i].label, fontBold, FONT_SIZE, COLS[i].width - 5);
    page.drawText(label, { x: COL_X[i] + 3, y: bottom + 9, size: FONT_SIZE, font: fontBold, color: BLACK });
  }

  page.drawLine({ start: { x: MARGIN, y: top }, end: { x: MARGIN + TABLE_W, y: top }, thickness: 0.7, color: GREY_BORDER });
  page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: MARGIN + TABLE_W, y: bottom }, thickness: 0.7, color: GREY_BORDER });
  drawColumnDividers(page, top, bottom);

  return bottom;
}

function drawRow(page, y, rowNum, order, fonts) {
  const { font } = fonts;
  const top = y;
  const bottom = y - ROW_H;

  const qty = order.lineItems?.reduce?.((s, i) => s + (i.quantity || 1), 0) || 1;
  // Paid orders have no cash to collect on delivery
  const codVal = order.financialStatus === "paid" ? 0 : Number(order.totalPrice || 0);

  const cells = [
    String(rowNum),
    order.trackingNumber || "",
    formatDate(order.createdAt),
    order.customerName || "",
    order.city || "",
    order.name || "",
    String(qty),
    codVal === 0 ? "0.00" : codVal.toFixed(2),
    "cod",
  ];

  if (rowNum % 2 === 0) {
    page.drawRectangle({ x: MARGIN, y: bottom, width: TABLE_W, height: ROW_H, color: GREY_ALT_BG });
  }

  // Columns that need truncation (Shipment No, Send date, Recipient, Delivery point)
  const truncateCols = new Set([1, 2, 3, 4]);
  for (let i = 0; i < COLS.length; i++) {
    const raw = cells[i];
    const text = truncateCols.has(i) ? truncate(raw, font, FONT_SIZE, COLS[i].width - 6) : raw;
    page.drawText(text, { x: COL_X[i] + 3, y: bottom + 9, size: FONT_SIZE, font, color: BLACK });
  }

  page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: MARGIN + TABLE_W, y: bottom }, thickness: 0.4, color: GREY_BORDER });
  drawColumnDividers(page, top, bottom);

  return bottom;
}

function drawFooter(page, y, totalCOD, totalWeight, count, fonts) {
  const { font, fontBold } = fonts;
  const ty = y - 14;
  page.drawText(`Total: ${totalCOD.toFixed(2)} Pkr`, { x: MARGIN, y: ty, size: 10, font: fontBold, color: BLACK });
  page.drawText(`Total weight: ${totalWeight.toFixed(1)} kg`, { x: MARGIN, y: ty - 16, size: 10, font: fontBold, color: BLACK });

  const sigY = ty - 52;
  page.drawText(`I received ${count} shipments`, { x: MARGIN + 30, y: sigY, size: 10, font, color: GREY_TEXT });
  page.drawText(`I delivered ${count} shipments`, { x: PAGE_W / 2 + 20, y: sigY, size: 10, font, color: GREY_TEXT });
}

export async function generateLoadsheetPdf(orders, settings) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fonts = { font, fontBold };

  // Load logo once — silent fallback if missing
  let logoImage = null;
  try {
    const logoBytes = fs.readFileSync(path.resolve("public", "insta-logo.png"));
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch (_) {}

  // Exclude paid orders from COD total — they've already been paid online
  const totalCOD = orders.reduce((sum, o) =>
    sum + (o.financialStatus === "paid" ? 0 : Number(o.totalPrice || 0)), 0);
  const totalWeight = orders.length * (settings?.defaultWeight || 1);

  // First page with sender header
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = drawSenderHeader(page, settings, logoImage, fonts);
  y = drawTableHeader(page, y, fonts);

  for (let i = 0; i < orders.length; i++) {
    if (y - ROW_H < FOOTER_RESERVE) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      y = drawTableHeader(page, y, fonts); // column headers only on continuation pages
    }
    y = drawRow(page, y, i + 1, orders[i], fonts);
  }

  drawFooter(page, y, totalCOD, totalWeight, orders.length, fonts);

  return pdfDoc.save();
}
