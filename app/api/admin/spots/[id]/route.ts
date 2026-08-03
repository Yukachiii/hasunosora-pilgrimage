import { spots, type PilgrimageSpot } from "@/app/spots";
import { deleteSpotOverride, upsertSpotOverride } from "@/db/content";
import { adminApiError, getAdminUser } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label}を入力してください。`);
  if (text.length > maxLength) {
    throw new Error(`${label}は${maxLength}文字以内にしてください。`);
  }
  return text;
}

function coordinate(value: unknown, label: string, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}が正しくありません。`);
  }
  return number;
}

function officialUrl(value: unknown) {
  const text = requiredText(value, "公式URL", 500);
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("公式URLはhttpまたはhttpsで入力してください。");
  }
  return url.toString();
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAdminUser();
  if (!user) return adminApiError();

  try {
    const { id } = await context.params;
    const base = spots.find((spot) => spot.id === id);
    if (!base) {
      return Response.json({ error: "スポットが見つかりません。" }, { status: 404 });
    }

    const payload = (await request.json()) as Record<string, unknown>;
    const categories = new Set(spots.map((spot) => spot.category));
    const category = requiredText(payload.category, "カテゴリ", 30);
    if (!categories.has(category as PilgrimageSpot["category"])) {
      throw new Error("カテゴリが正しくありません。");
    }

    const edited: PilgrimageSpot = {
      ...base,
      name: requiredText(payload.name, "名称", 100),
      shortName: requiredText(payload.shortName, "短縮名", 60),
      area: requiredText(payload.area, "エリア", 40),
      category: category as PilgrimageSpot["category"],
      address: requiredText(payload.address, "住所", 160),
      lat: coordinate(payload.lat, "緯度", -90, 90),
      lng: coordinate(payload.lng, "経度", -180, 180),
      description: requiredText(payload.description, "説明", 500),
      accessNote: requiredText(payload.accessNote, "アクセス案内", 160),
      sourceUrl: officialUrl(payload.sourceUrl),
    };

    await upsertSpotOverride(edited, user.userId);
    return Response.json({ spot: edited });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存できませんでした。";
    const status =
      error instanceof SyntaxError ||
      /入力|文字以内|正しく|URL|カテゴリ/.test(message)
        ? 400
        : 500;
    if (status === 500) console.error("Failed to save spot", error);
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAdminUser();
  if (!user) return adminApiError();

  try {
    const { id } = await context.params;
    if (!spots.some((spot) => spot.id === id)) {
      return Response.json({ error: "スポットが見つかりません。" }, { status: 404 });
    }
    await deleteSpotOverride(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to reset spot", error);
    return Response.json(
      { error: "登録時の情報へ戻せませんでした。" },
      { status: 500 },
    );
  }
}
