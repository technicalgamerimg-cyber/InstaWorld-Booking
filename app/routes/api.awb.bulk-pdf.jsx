import { authenticate } from "../shopify.server";
import db from "../db.server";
import { PDFDocument } from "pdf-lib";
import pLimit from "p-limit";

const INSTAWORLD_AWB = "https://one-be.instaworld.pk/logistics/v1/awb";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { ids } = await request.json();

  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response("No order IDs provided", { status: 400 });
  }

  const [orders, settings] = await Promise.all([
    db.order.findMany({
      where: { id: { in: ids.map(Number) }, shop: session.shop, trackingNumber: { not: null } },
      select: { id: true, trackingNumber: true, name: true },
    }),
    db.settings.findUnique({ where: { shop: session.shop } }),
  ]);

  if (!settings?.instaworldApiKey) {
    return new Response("API key not configured", { status: 400 });
  }

  const limit = pLimit(5);

  // Phase 1: fetch all AWB PDFs in parallel (independent — safe to parallelize)
  const buffers = await Promise.all(
    orders.map((order) =>
      limit(async () => {
        const url = `${INSTAWORLD_AWB}?tracking_number=${encodeURIComponent(order.trackingNumber)}&token=${encodeURIComponent(settings.instaworldApiKey)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return { name: order.name, buffer: await res.arrayBuffer() };
      })
    )
  );

  // Phase 2: merge sequentially — PDFDocument is NOT concurrency-safe
  const merged = await PDFDocument.create();
  for (const item of buffers) {
    if (!item) continue;
    try {
      const donor = await PDFDocument.load(item.buffer);
      const pages = await merged.copyPages(donor, donor.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch (e) {
      console.error(`Failed to merge AWB for ${item.name}:`, e.message);
    }
  }

  const pdfBytes = await merged.save();
  const date = new Date().toISOString().slice(0, 10);

  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="awb-labels-${date}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
};
