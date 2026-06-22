import { toBuffer } from "bwip-js";

export const loader = async ({ params, request }) => {
  const { text } = params;
  const url = new URL(request.url);
  const scale = Number(url.searchParams.get("scale") || 3);
  const includeText = url.searchParams.get("includeText") !== "false";

  try {
    const png = await toBuffer({
      bcid: "code128",
      text: text || " ",
      scale,
      height: 12,
      includetext: includeText,
      textxalign: "center",
    });

    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    console.error("Barcode generation failed for text:", text, e.message);
    return new Response("Barcode generation failed", { status: 500 });
  }
};
