import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generateLoadsheetPdf } from "../utils/loadsheet.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const record = await db.loadsheet.findFirst({
    where: { id: Number(params.id), shop: session.shop },
  });

  if (!record) {
    return new Response("Loadsheet not found", { status: 404 });
  }

  const orderIds = Array.isArray(record.orderIds) ? record.orderIds : [];

  const [orders, settings] = await Promise.all([
    db.order.findMany({
      where: { id: { in: orderIds.map(Number) }, shop: session.shop },
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

  const pdfBytes = await generateLoadsheetPdf(
    orders.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    settings
  );

  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${record.filename || `loadsheet-${record.id}.pdf`}"`,
      "Cache-Control": "private, no-store",
    },
  });
};
