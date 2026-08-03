import { adminApiError, getAdminUser } from "@/lib/admin-auth";
import { deleteMediaAsset } from "@/db/content";
import { getMediaBucket } from "@/storage/media";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAdminUser();
  if (!user) return adminApiError();

  try {
    const { id } = await context.params;
    const asset = await deleteMediaAsset(id);
    if (!asset) {
      return Response.json({ error: "画像が見つかりません。" }, { status: 404 });
    }

    const bucket = await getMediaBucket();
    await Promise.all([
      bucket.delete(asset.originalKey),
      bucket.delete(asset.publicKey),
    ]);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete media", error);
    return Response.json(
      { error: "画像を削除できませんでした。" },
      { status: 500 },
    );
  }
}
