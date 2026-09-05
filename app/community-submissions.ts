export const communitySubmissionKinds = ["photo", "spot"] as const;
export const communitySubmissionStatuses = [
  "pending",
  "approved",
  "rejected",
  "imported",
] as const;

export type CommunitySubmissionKind =
  (typeof communitySubmissionKinds)[number];
export type CommunitySubmissionStatus =
  (typeof communitySubmissionStatuses)[number];

export type PhotoSubmissionPayload = {
  spotId: string;
  comment?: string;
};

export type SpotSubmissionPayload = {
  name: string;
  address: string;
  sourceUrl: string;
  shortName?: string;
  area?: string;
  category?: string;
  description?: string;
  accessNote?: string;
  lat?: number;
  lng?: number;
  comment?: string;
};

export type CommunitySubmissionPayloadByKind = {
  photo: PhotoSubmissionPayload;
  spot: SpotSubmissionPayload;
};

export type CommunitySubmissionPayload =
  CommunitySubmissionPayloadByKind[CommunitySubmissionKind];

export class CommunitySubmissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunitySubmissionValidationError";
  }
}

const spotIdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const forbiddenHtmlPattern = /[<>]|&(?:lt|gt|#0*60|#x0*3c|#0*62|#x0*3e);/i;
const forbiddenControlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const photoKeys = new Set(["spotId", "comment"]);
const spotKeys = new Set([
  "name",
  "address",
  "sourceUrl",
  "shortName",
  "area",
  "category",
  "description",
  "accessNote",
  "lat",
  "lng",
  "comment",
]);

function isBlockedSourceHostname(value: string) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) return true;

  if (hostname.includes(":")) {
    if (
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fe8") ||
      hostname.startsWith("fe9") ||
      hostname.startsWith("fea") ||
      hostname.startsWith("feb") ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("::ffff:")
    ) return true;
    return false;
  }

  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [, firstText, secondText, thirdText, fourthText] = ipv4;
  const octets = [firstText, secondText, thirdText, fourthText].map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [first, second] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224;
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommunitySubmissionValidationError(
      "投稿内容の形式が正しくありません。",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CommunitySubmissionValidationError(
      "投稿内容の形式が正しくありません。",
    );
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
) {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new CommunitySubmissionValidationError(
      "投稿内容に使用できない項目が含まれています。",
    );
  }
}

function normalizeText(
  value: unknown,
  label: string,
  maximumLength: number,
  options: { required?: boolean } = {},
) {
  if (value === undefined || value === null || value === "") {
    if (options.required) {
      throw new CommunitySubmissionValidationError(`${label}を入力してください。`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CommunitySubmissionValidationError(`${label}が正しくありません。`);
  }
  const text = value.normalize("NFKC").trim();
  if (!text && options.required) {
    throw new CommunitySubmissionValidationError(`${label}を入力してください。`);
  }
  if (!text) return undefined;
  if (text.length > maximumLength) {
    throw new CommunitySubmissionValidationError(
      `${label}は${maximumLength}文字以内にしてください。`,
    );
  }
  if (
    forbiddenHtmlPattern.test(text) ||
    forbiddenControlCharacterPattern.test(text)
  ) {
    throw new CommunitySubmissionValidationError(
      `${label}にHTMLや制御文字は使用できません。`,
    );
  }
  return text;
}

function requiredUrl(value: unknown) {
  const text = normalizeText(value, "根拠URL", 500, { required: true })!;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CommunitySubmissionValidationError(
      "根拠URLが正しくありません。",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CommunitySubmissionValidationError(
      "根拠URLはhttpまたはhttpsで入力してください。",
    );
  }
  if (url.username || url.password) {
    throw new CommunitySubmissionValidationError(
      "根拠URLにユーザー名やパスワードは使用できません。",
    );
  }
  if (isBlockedSourceHostname(url.hostname)) {
    throw new CommunitySubmissionValidationError(
      "根拠URLに端末内やローカルネットワークのアドレスは使用できません。",
    );
  }
  return url.toString();
}

function optionalCoordinate(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommunitySubmissionValidationError(`${label}が正しくありません。`);
  }
  if (value < minimum || value > maximum) {
    throw new CommunitySubmissionValidationError(`${label}が正しくありません。`);
  }
  return value;
}

export function parseCommunitySubmissionKind(
  value: unknown,
): CommunitySubmissionKind {
  if (value === "photo" || value === "spot") return value;
  throw new CommunitySubmissionValidationError("投稿の種類が正しくありません。");
}

export function parseCommunitySubmissionStatus(
  value: unknown,
): CommunitySubmissionStatus {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "imported"
  ) {
    return value;
  }
  throw new CommunitySubmissionValidationError("投稿の状態が正しくありません。");
}

export function parsePhotoSubmissionPayload(
  value: unknown,
): PhotoSubmissionPayload {
  const payload = assertPlainObject(value);
  assertOnlyKeys(payload, photoKeys);
  const spotId = normalizeText(payload.spotId, "スポット", 80, {
    required: true,
  })!;
  if (!spotIdPattern.test(spotId)) {
    throw new CommunitySubmissionValidationError(
      "スポットの指定が正しくありません。",
    );
  }
  const comment = normalizeText(payload.comment, "補足", 500);
  return { spotId, ...(comment ? { comment } : {}) };
}

export function parseSpotSubmissionPayload(
  value: unknown,
): SpotSubmissionPayload {
  const payload = assertPlainObject(value);
  assertOnlyKeys(payload, spotKeys);

  const name = normalizeText(payload.name, "名称", 100, { required: true })!;
  const address = normalizeText(payload.address, "住所", 160, {
    required: true,
  })!;
  const sourceUrl = requiredUrl(payload.sourceUrl);
  const shortName = normalizeText(payload.shortName, "短縮名", 60);
  const area = normalizeText(payload.area, "エリア", 40);
  const category = normalizeText(payload.category, "分類", 30);
  const description = normalizeText(payload.description, "説明", 500);
  const accessNote = normalizeText(payload.accessNote, "アクセス案内", 160);
  const comment = normalizeText(payload.comment, "補足", 500);
  const lat = optionalCoordinate(payload.lat, "緯度", -90, 90);
  const lng = optionalCoordinate(payload.lng, "経度", -180, 180);

  if ((lat === undefined) !== (lng === undefined)) {
    throw new CommunitySubmissionValidationError(
      "位置情報を入力する場合は緯度と経度を両方指定してください。",
    );
  }

  return {
    name,
    address,
    sourceUrl,
    ...(shortName ? { shortName } : {}),
    ...(area ? { area } : {}),
    ...(category ? { category } : {}),
    ...(description ? { description } : {}),
    ...(accessNote ? { accessNote } : {}),
    ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
    ...(comment ? { comment } : {}),
  };
}

export function parseCommunitySubmissionPayload<
  Kind extends CommunitySubmissionKind,
>(kind: Kind, value: unknown): CommunitySubmissionPayloadByKind[Kind] {
  return (kind === "photo"
    ? parsePhotoSubmissionPayload(value)
    : parseSpotSubmissionPayload(value)) as CommunitySubmissionPayloadByKind[Kind];
}

export function parseCommunityCreditName(value: unknown) {
  return normalizeText(value, "掲載名", 60, { required: true })!;
}
