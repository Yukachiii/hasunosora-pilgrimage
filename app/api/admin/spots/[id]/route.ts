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

function optionalStayMinutes(value: unknown, current?: number) {
  if (value === undefined || value === null || value === "") return current;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 480) {
    throw new Error("推奨滞在時間は0～480分で入力してください。");
  }
  return number;
}

function optionalTime(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label}は時刻として入力してください。`);
  }
  return value;
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label}が正しくありません。`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label}が正しくありません。`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label}は${maxLength}文字以内にしてください。`);
  return text || undefined;
}

function closedWeekdays(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
    throw new Error("休業曜日が正しくありません。");
  }
  return Array.from(new Set(value as number[])).sort();
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
    const openingTime = optionalTime(payload.openingTime, "営業開始時刻");
    const closingTime = optionalTime(payload.closingTime, "営業終了時刻");
    if (Boolean(openingTime) !== Boolean(closingTime)) {
      throw new Error("営業開始時刻と終了時刻は両方入力してください。");
    }
    if (openingTime && closingTime && openingTime >= closingTime) {
      throw new Error("営業終了時刻は開始時刻より後にしてください。");
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
      recommendedStayMinutes: optionalStayMinutes(
        payload.recommendedStayMinutes,
        base.recommendedStayMinutes,
      ),
      openingTime,
      closingTime,
      closedWeekdays: closedWeekdays(payload.closedWeekdays),
      openingHoursNote: optionalText(payload.openingHoursNote, "営業時間の補足", 300),
      openingHoursCheckedAt: optionalDate(payload.openingHoursCheckedAt, "営業時間の確認日"),
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
