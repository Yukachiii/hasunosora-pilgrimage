import { findMediaAsset } from "@/db/content";
import { getMediaBucket } from "@/storage/media";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const asset = await findMediaAsset(id);
    if (!asset || asset.status !== "published") {
      return new Response("Not found", { status: 404 });
    }

    const object = await (await getMediaBucket()).get(asset.publicKey);
    if (!object) return new Response("Not found", { status: 404 });

    return new Response(object.body, {
      headers: {
        "content-type": asset.publicContentType,
        "content-length": String(object.size),
        "cache-control": "public, max-age=3600, s-maxage=86400",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Failed to serve media", error);
    return new Response("Not found", { status: 404 });
  }
}
