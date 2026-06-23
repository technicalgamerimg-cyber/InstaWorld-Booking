import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generateLoadsheetPdf } from "../utils/loadsheet.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { ids } = await request.json();

  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response("No order IDs provided", { status: 400 });
  }

  const [orders, settings] = await Promise.all([
    db.order.findMany({
      where: {
        id: { in: ids.map(Number) },
        shop: session.shop,
        bookingStatus: "booked",
        trackingNumber: { not: null },
      },
      select: {
        id: true,
        name: true,
        customerName: true,
        city: true,
        trackingNumber: true,
        totalPrice: true,
        financialStatus: true,
        createdAt: true,
        lineItems: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.settings.findUnique({ where: { shop: session.shop } }),
  ]);

  if (orders.length === 0) {
    return new Response("No booked orders found for the selected IDs", { status: 404 });
  }

  const pdfBytes = await generateLoadsheetPdf(
    orders.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    settings
  );

  const date = new Date().toISOString().slice(0, 10);
  const filename = `loadsheet-${date}.pdf`;
  const totalCOD = orders.reduce((sum, o) =>
    sum + (o.financialStatus === "paid" ? 0 : Number(o.totalPrice || 0)), 0);

  await db.loadsheet.create({
    data: {
      shop: session.shop,
      orderCount: orders.length,
      totalCOD,
      orderIds: orders.map((o) => o.id),
      filename,
    },
  });

  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
};
