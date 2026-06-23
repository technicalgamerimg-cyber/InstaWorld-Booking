import { authenticate } from "../shopify.server";
import db from "../db.server";

const INSTAWORLD_AWB = "https://one-be.instaworld.pk/logistics/v1/awb";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const { trackingNumber } = params;

  const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
  if (!shopSettings?.instaworldApiKey) {
    return new Response("API key not configured", { status: 400 });
  }

  const url = `${INSTAWORLD_AWB}?tracking_number=${encodeURIComponent(trackingNumber)}&token=${encodeURIComponent(shopSettings.instaworldApiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    return new Response(`InstaWorld AWB error: ${res.status}`, { status: 502 });
  }

  const contentType = res.headers.get("Content-Type") || "application/pdf";
  const buffer = await res.arrayBuffer();

  return new Response(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="awb-${trackingNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
};
