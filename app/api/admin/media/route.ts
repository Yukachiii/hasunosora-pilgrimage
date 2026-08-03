import { getAdminUser, adminApiError } from "@/lib/admin-auth";
import { spots } from "@/app/spots";
import { insertMediaAsset, listAdminMedia } from "@/db/content";
import { getMediaBucket } from "@/storage/media";

export const dynamic = "force-dynamic";

const allowedOriginalTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedPublicTypes = new Set(["image/webp", "image/jpeg"]);

type UploadMetadata = {
  placement?: unknown;
  spotId?: unknown;
  cropX?: unknown;
  cropY?: unknown;
  zoom?: unknown;
  gpsLat?: unknown;
  gpsLng?: unknown;
  nearestSpotId?: unknown;
};

function asFiniteNumber(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeFileName(value: string) {
  const safe = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "upload";
}

function serializeAsset(asset: Awaited<ReturnType<typeof insertMediaAsset>>) {
  return {
    id: asset.id,
    originalName: asset.originalName,
    placement: asset.placement,
    spotId: asset.spotId,
    cropX: asset.cropX,
    cropY: asset.cropY,
    zoom: asset.zoom,
    gpsLat: asset.gpsLat,
    gpsLng: asset.gpsLng,
    nearestSpotId: asset.nearestSpotId,
    status: asset.status,
    createdAt: asset.createdAt,
    imageUrl: `/api/media/${asset.id}`,
  };
}

export async function GET() {
  const user = await getAdminUser();
  if (!user) return adminApiError();

  try {
    const assets = await listAdminMedia();
    return Response.json({ assets: assets.map(serializeAsset) });
  } catch (error) {
    console.error("Failed to list admin media", error);
    return Response.json(
      { error: "画像一覧を読み込めませんでした。" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const user = await getAdminUser();
  if (!user) return adminApiError();

  let originalKey = "";
  let publicKey = "";
  const bucket = await getMediaBucket();

  try {
    const formData = await request.formData();
    const original = formData.get("original");
    const derivative = formData.get("derivative");
    const rawMetadata = formData.get("metadata");

    if (!(original instanceof File) || !(derivative instanceof File)) {
      return Response.json(
        { error: "元画像と公開用画像が必要です。" },
        { status: 400 },
      );
    }
    if (original.size <= 0 || original.size > 25 * 1024 * 1024) {
      return Response.json(
        { error: "元画像は25MB以下にしてください。" },
        { status: 400 },
      );
    }
    if (derivative.size <= 0 || derivative.size > 5 * 1024 * 1024) {
      return Response.json(
        { error: "公開用画像の生成に失敗しました。" },
        { status: 400 },
      );
    }
    if (!allowedOriginalTypes.has(original.type)) {
      return Response.json(
        { error: "JPEG、PNG、WebPの画像を選んでください。" },
        { status: 400 },
      );
    }
    if (!allowedPublicTypes.has(derivative.type)) {
      return Response.json(
        { error: "公開用画像の形式が正しくありません。" },
        { status: 400 },
      );
    }

    let metadata: UploadMetadata = {};
    if (typeof rawMetadata === "string") {
      try {
        metadata = JSON.parse(rawMetadata) as UploadMetadata;
      } catch {
        return Response.json(
          { error: "画像設定を読み取れませんでした。" },
          { status: 400 },
        );
      }
    }

    const placement = metadata.placement === "hero" ? "hero" : "spot";
    const requestedSpotId =
      typeof metadata.spotId === "string" ? metadata.spotId : null;
    const spotId =
      placement === "spot" && spots.some((spot) => spot.id === requestedSpotId)
        ? requestedSpotId
        : null;
    if (placement === "spot" && !spotId) {
      return Response.json(
        { error: "配置するスポットを選んでください。" },
        { status: 400 },
      );
    }

    const gpsLat = asFiniteNumber(metadata.gpsLat, Number.NaN);
    const gpsLng = asFiniteNumber(metadata.gpsLng, Number.NaN);
    const id = crypto.randomUUID();
    originalKey = `originals/${id}/${safeFileName(original.name)}`;
    publicKey = `published/${id}.${derivative.type === "image/webp" ? "webp" : "jpg"}`;

    await bucket.put(originalKey, original.stream(), {
      httpMetadata: { contentType: original.type },
      customMetadata: {
        ownerId: user.userId,
        originalName: original.name,
      },
    });
    await bucket.put(publicKey, derivative.stream(), {
      httpMetadata: { contentType: derivative.type },
      customMetadata: { sourceId: id },
    });

    const created = await insertMediaAsset({
      id,
      originalKey,
      publicKey,
      originalName: original.name,
      originalContentType: original.type,
      publicContentType: derivative.type,
      placement,
      spotId,
      cropX: clamp(asFiniteNumber(metadata.cropX, 50), 0, 100),
      cropY: clamp(asFiniteNumber(metadata.cropY, 50), 0, 100),
      zoom: clamp(asFiniteNumber(metadata.zoom, 1), 1, 2.5),
      gpsLat: Number.isFinite(gpsLat) && Math.abs(gpsLat) <= 90 ? gpsLat : null,
      gpsLng: Number.isFinite(gpsLng) && Math.abs(gpsLng) <= 180 ? gpsLng : null,
      nearestSpotId:
        typeof metadata.nearestSpotId === "string" &&
        spots.some((spot) => spot.id === metadata.nearestSpotId)
          ? metadata.nearestSpotId
          : null,
      status: "published",
      createdBy: user.userId,
    });

    return Response.json({ asset: serializeAsset(created) }, { status: 201 });
  } catch (error) {
    console.error("Failed to upload media", error);
    if (originalKey) await bucket.delete(originalKey).catch(() => undefined);
    if (publicKey) await bucket.delete(publicKey).catch(() => undefined);
    return Response.json(
      { error: "画像を保存できませんでした。少し待ってから再度お試しください。" },
      { status: 500 },
    );
  }
}
