import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(projectDirectory, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const adminDirectory = path.join(projectDirectory, "admin-dist");
const contentDirectory = path.join(projectDirectory, "content");
const spotsPath = path.join(contentDirectory, "spots.json");
const mediaPath = path.join(contentDirectory, "media.json");
const sitePath = path.join(contentDirectory, "site.json");
const transitNamesPath = path.join(contentDirectory, "transit-search-names.json");
const photosDirectory = path.join(projectDirectory, "public", "photos");
const communitySubmissionsDirectory = path.resolve(
  process.env.COMMUNITY_SUBMISSIONS_DIRECTORY ||
    path.join(projectDirectory, "private", "community-submissions"),
);
const communitySubmissionIndexPath = path.join(communitySubmissionsDirectory, "index.json");
const adminApplicationId = "hasunosora-pilgrimage-admin";
const writeToken = randomBytes(32).toString("base64url");
const maximumJsonBody = 8 * 1024 * 1024;
const allowedCategories = new Set([
  "交通", "まち歩き", "眺望", "宿泊", "甘味", "海辺", "文化",
  "飲食", "買い物", "レジャー", "寺社",
]);
const spotIdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const assetIdPattern = /^(?:[a-f0-9]{16}|kanazawa-station-20260724)$/;
const submissionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
let writeQueue = Promise.resolve();

class AdminError extends Error {}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new AdminError(`${path.basename(filePath)}を読み込めません。`);
  }
}

async function writeJsonIfChanged(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await readFile(filePath, "utf8")) === serialized) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}

async function writeBytesAtomic(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireCommunityIndexLock() {
  await mkdir(communitySubmissionsDirectory, { recursive: true });
  const lockPath = `${communitySubmissionIndexPath}.lock`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = `${process.pid}:${randomUUID()}`;
      try {
        await handle.writeFile(`${token}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        const currentToken = await readFile(lockPath, "utf8").catch(() => "");
        if (currentToken.trim() === token) {
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > 120_000) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      await wait(25 + Math.floor(Math.random() * 25));
    }
  }
  throw new AdminError("投稿受付が保存処理中です。少し待ってから再度お試しください。");
}

async function readCommunitySubmissions() {
  const submissions = await readJson(communitySubmissionIndexPath, []);
  if (!Array.isArray(submissions)) throw new AdminError("投稿審査データが正しくありません。");
  return submissions;
}

function serializeCommunitySubmission(submission) {
  return {
    id: String(submission.id || ""),
    kind: submission.kind === "spot" ? "spot" : "photo",
    status: ["pending", "approved", "rejected", "imported"].includes(submission.status)
      ? submission.status
      : "pending",
    payload: submission.payload && typeof submission.payload === "object" ? submission.payload : {},
    creditName: typeof submission.creditName === "string" ? submission.creditName : null,
    imageKey: typeof submission.imageKey === "string" ? submission.imageKey : null,
    imageMime: typeof submission.imageMime === "string" ? submission.imageMime : null,
    imageSize: Number.isFinite(submission.imageSize) ? submission.imageSize : null,
    createdAt: typeof submission.createdAt === "string" ? submission.createdAt : "",
    reviewedAt: typeof submission.reviewedAt === "string" ? submission.reviewedAt : null,
    reviewNote: typeof submission.reviewNote === "string" ? submission.reviewNote : null,
  };
}

async function withCommunitySubmissionIndex(operation) {
  return withWriteLock(async () => {
    const releaseLock = await acquireCommunityIndexLock();
    try {
      const submissions = await readCommunitySubmissions();
      const result = await operation(submissions);
      await writeJsonIfChanged(communitySubmissionIndexPath, submissions);
      return result;
    } finally {
      await releaseLock();
    }
  });
}

function withWriteLock(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => undefined);
  return next;
}

function isLoopback(value = "") {
  const normalized = value.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isPrivateIpv4(value = "") {
  const normalized = value.replace(/^::ffff:/, "");
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function isTrustedLanAddress(value = "") {
  return isLoopback(value) || isPrivateIpv4(value);
}

function findLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return "";
}

function isLocalRequest(request) {
  if (!isTrustedLanAddress(request.socket.remoteAddress)) return false;
  const host = String(request.headers.host ?? "");
  let hostname = "";
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!isTrustedLanAddress(hostname)) return false;
  const origin = String(request.headers.origin ?? "");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host && isTrustedLanAddress(parsed.hostname);
  } catch {
    return false;
  }
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeChild(root, relative) {
  if (!relative || path.isAbsolute(relative)) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  return candidate.startsWith(`${resolvedRoot}${path.sep}`) ? candidate : null;
}

function requiredText(value, label, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw new AdminError(`${label}を入力してください。`);
  if (text.length > maximum) throw new AdminError(`${label}は${maximum}文字以内にしてください。`);
  return text;
}

function optionalTextList(value, current, label) {
  const items = value ?? current ?? [];
  if (!Array.isArray(items) || items.length > 20) {
    throw new AdminError(`${label}が正しくありません。`);
  }
  return items.map((item) => requiredText(item, label, 160));
}

function coordinate(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new AdminError(`${label}が正しくありません。`);
  }
  return number;
}

function optionalStayMinutes(value, current) {
  if (value === undefined || value === null || value === "") return current;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 480) {
    throw new AdminError("推奨滞在時間は0～480分で入力してください。");
  }
  return number;
}

function optionalTime(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new AdminError(`${label}は時刻として入力してください。`);
  }
  return text;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new AdminError(`${label}が正しくありません。`);
  }
  return text;
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (text.length > maximum) throw new AdminError(`${label}は${maximum}文字以内にしてください。`);
  return text;
}

function closedWeekdays(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new AdminError("休業曜日が正しくありません。");
  }
  return Array.from(new Set(value)).sort();
}

function officialUrl(value) {
  const text = requiredText(value, "参照URL", 500);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new AdminError("参照URLはhttpまたはhttpsで入力してください。");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new AdminError("参照URLはhttpまたはhttpsで入力してください。");
  }
  return text;
}

function validateSpot(value, spotId, current) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminError("スポット情報が正しくありません。");
  }
  const category = requiredText(value.category, "カテゴリ", 30);
  if (!allowedCategories.has(category)) throw new AdminError("カテゴリが正しくありません。");
  const activityRecords = optionalTextList(
    value.activityRecords,
    current.activityRecords,
    "活動記録",
  );
  const sehasEpisodes = optionalTextList(
    value.sehasEpisodes,
    current.sehasEpisodes,
    "せーはす！放送回",
  );
  const withMeetsEpisodes = optionalTextList(
    value.withMeetsEpisodes,
    current.withMeetsEpisodes,
    "With×MEETS配信回",
  );
  const normalizedAppearances = optionalTextList(
    value.appearances,
    current.appearances,
    "カード・その他の登場情報",
  );
  const openingTime = optionalTime(value.openingTime, "営業開始時刻");
  const closingTime = optionalTime(value.closingTime, "営業終了時刻");
  if (Boolean(openingTime) !== Boolean(closingTime)) {
    throw new AdminError("営業開始時刻と終了時刻は両方入力してください。");
  }
  if (openingTime && closingTime && openingTime >= closingTime) {
    throw new AdminError("営業終了時刻は開始時刻より後にしてください。");
  }
  return {
    ...current,
    id: spotId,
    name: requiredText(value.name, "名称", 100),
    shortName: requiredText(value.shortName, "短縮名", 60),
    area: requiredText(value.area, "エリア", 40),
    category,
    address: requiredText(value.address, "住所", 160),
    lat: coordinate(value.lat, "緯度", -90, 90),
    lng: coordinate(value.lng, "経度", -180, 180),
    description: requiredText(value.description, "説明", 500),
    recommendedStayMinutes: optionalStayMinutes(
      value.recommendedStayMinutes,
      current.recommendedStayMinutes,
    ),
    openingTime,
    closingTime,
    closedWeekdays: closedWeekdays(value.closedWeekdays),
    openingHoursNote: optionalText(value.openingHoursNote, "営業時間の補足", 300),
    openingHoursCheckedAt: optionalDate(value.openingHoursCheckedAt, "営業時間の確認日"),
    activityRecords,
    sehasEpisodes,
    withMeetsEpisodes,
    accessNote: requiredText(value.accessNote, "アクセス案内", 160),
    sourceUrl: officialUrl(value.sourceUrl),
    appearances: normalizedAppearances,
  };
}

function siteHeroImages(site) {
  return Array.from(new Set([
    site?.heroImage,
    ...(Array.isArray(site?.heroImages) ? site.heroImages : []),
  ].filter((imageUrl) => typeof imageUrl === "string" && imageUrl.startsWith("/photos/"))));
}

function updateSiteHeroImages(site, imageUrls) {
  const [heroImage = null, ...heroImages] = Array.from(new Set(imageUrls));
  site.heroImage = heroImage;
  site.heroImages = heroImages;
  return site;
}

function normalizedSiteVersion(value, fallback = "4.0.0") {
  const version = String(value ?? "").trim().replace(/^ver\.\s*/i, "");
  return /^\d+\.\d+\.\d+$/.test(version) ? version : fallback;
}

async function updateSiteVersion(payload) {
  if (!payload || typeof payload !== "object") {
    throw new AdminError("バージョン表記が正しくありません。");
  }
  const version = normalizedSiteVersion(payload.version, "");
  if (!version) throw new AdminError("バージョンは3桁（例：3.1.0）で入力してください。");
  return withWriteLock(async () => {
    const site = await readJson(sitePath, { heroImage: null, heroImages: [] });
    site.version = version;
    await writeJsonIfChanged(sitePath, site);
    return version;
  });
}

function serializeAsset(asset, heroImageSet) {
  const imageUrl = asset.imageUrl || "";
  return {
    id: asset.id,
    originalName: asset.displayName || "公開画像",
    placement: asset.placement || "spot",
    spotId: asset.spotId ?? null,
    createdAt: asset.createdAt || "",
    imageUrl,
    creditName: typeof asset.creditName === "string" ? asset.creditName : undefined,
    source: typeof asset.source === "string" ? asset.source : undefined,
    submissionId: typeof asset.submissionId === "string" ? asset.submissionId : undefined,
    heroCandidate: heroImageSet
      ? heroImageSet.has(imageUrl)
      : asset.placement === "hero",
  };
}

function sendJson(response, value, status = 200) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

async function readJsonBody(request, maximum = maximumJsonBody) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new AdminError("JSON形式で送信してください。");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new AdminError("送信データのサイズが正しくありません。");
    chunks.push(chunk);
  }
  if (!length) throw new AdminError("送信データがありません。");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdminError("送信されたJSONを読み込めません。");
  }
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

async function sendFile(response, filePath) {
  if (!filePath) {
    sendJson(response, { error: "ファイルが見つかりません。" }, 404);
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    sendJson(response, { error: error?.code === "ENOENT" ? "ファイルが見つかりません。" : "ファイルを読み込めません。" }, error?.code === "ENOENT" ? 404 : 500);
  }
}

function gitProcess(gitArguments, timeout = 180_000) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${projectDirectory.replaceAll("\\", "/")}`, ...gitArguments],
    {
      cwd: projectDirectory,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function safeGitMessage(result) {
  const message = String(result.stderr || result.stdout || "Gitコマンドに失敗しました。")
    .replace(/(https?:\/\/)[^@\s]+@/g, "$1***@");
  return message.trim().slice(-800);
}

function gitStatus() {
  const inside = gitProcess(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      available: false,
      remoteConfigured: false,
      identityConfigured: false,
      branch: "",
      hasLocalChanges: false,
      error: "このフォルダーはGitリポジトリではありません。",
    };
  }
  const root = gitProcess(["rev-parse", "--show-toplevel"]);
  const branch = gitProcess(["branch", "--show-current"]);
  const remote = gitProcess(["remote", "get-url", "origin"]);
  const name = gitProcess(["config", "--get", "user.name"]);
  const email = gitProcess(["config", "--get", "user.email"]);
  const changes = gitProcess(["status", "--porcelain", "--", "content", "public/photos"]);
  const rootMatches = root.status === 0 && path.resolve(root.stdout.trim()) === path.resolve(projectDirectory);
  return {
    available: rootMatches,
    remoteConfigured: remote.status === 0 && Boolean(remote.stdout.trim()),
    identityConfigured: name.status === 0 && Boolean(name.stdout.trim()) && email.status === 0 && Boolean(email.stdout.trim()),
    branch: branch.status === 0 ? branch.stdout.trim() : "",
    hasLocalChanges: Boolean(changes.stdout.trim()),
    error: rootMatches ? "" : "プロジェクト直下のGitリポジトリを使用してください。",
  };
}

async function publishToGitHub() {
  const status = gitStatus();
  if (!status.available) throw new AdminError(status.error || "Gitを利用できません。");
  if (!status.remoteConfigured) throw new AdminError("GitHubリポジトリが設定されていません。");
  if (!status.identityConfigured) throw new AdminError("Gitのuser.nameとuser.emailを設定してください。");
  if (!status.branch) throw new AdminError("現在のGitブランチを取得できません。");

  return withWriteLock(async () => {
    const added = gitProcess(["add", "--", "content", "public/photos"]);
    if (added.status !== 0) throw new AdminError(`公開データの追加に失敗しました: ${safeGitMessage(added)}`);
    const diff = gitProcess(["diff", "--cached", "--quiet"]);
    if (![0, 1].includes(diff.status)) throw new AdminError(`変更確認に失敗しました: ${safeGitMessage(diff)}`);
    const committed = diff.status === 1;
    if (committed) {
      const commit = gitProcess(["commit", "-m", "Update pilgrimage content"]);
      if (commit.status !== 0) throw new AdminError(`コミットに失敗しました: ${safeGitMessage(commit)}`);
    }

    const upstream = gitProcess(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.status === 0) {
      const fetched = gitProcess(["fetch", "origin"]);
      if (fetched.status !== 0) throw new AdminError(`GitHubの最新状態を取得できませんでした: ${safeGitMessage(fetched)}`);
      const counts = gitProcess(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
      if (counts.status !== 0) throw new AdminError(`更新状況を確認できませんでした: ${safeGitMessage(counts)}`);
      const [, behindText = "0"] = counts.stdout.trim().split(/\s+/);
      if (Number(behindText) > 0) {
        const dirty = gitProcess(["status", "--porcelain"]);
        if (dirty.stdout.trim()) {
          throw new AdminError("GitHub側に新しい変更があります。未コミットの開発変更があるため、Codexで同期してください。");
        }
        const rebased = gitProcess(["rebase", "@{u}"]);
        if (rebased.status !== 0) {
          gitProcess(["rebase", "--abort"]);
          throw new AdminError(`GitHub側の変更と統合できませんでした: ${safeGitMessage(rebased)}`);
        }
      }
    }

    const pushed = gitProcess(upstream.status === 0 ? ["push"] : ["push", "--set-upstream", "origin", status.branch]);
    if (pushed.status !== 0) throw new AdminError(`プッシュに失敗しました: ${safeGitMessage(pushed)}`);
    const revision = gitProcess(["rev-parse", "--short", "HEAD"]);
    return { committed, pushed: true, revision: revision.status === 0 ? revision.stdout.trim() : "" };
  });
}

async function updateSpot(spotId, payload) {
  if (!spotIdPattern.test(spotId)) throw new AdminError("スポットIDが正しくありません。");
  return withWriteLock(async () => {
    const spots = await readJson(spotsPath, []);
    const index = spots.findIndex((spot) => spot.id === spotId);
    if (index < 0) throw new AdminError("スポットが見つかりません。");
    const edited = validateSpot(payload, spotId, spots[index]);
    spots[index] = edited;
    await writeJsonIfChanged(spotsPath, spots);
    return edited;
  });
}

async function resetSpot(spotId, initialSpots) {
  if (!spotIdPattern.test(spotId)) throw new AdminError("スポットIDが正しくありません。");
  return withWriteLock(async () => {
    const spots = await readJson(spotsPath, []);
    const index = spots.findIndex((spot) => spot.id === spotId);
    const baseline = initialSpots.find((spot) => spot.id === spotId);
    if (index < 0 || !baseline) throw new AdminError("サーバー起動時のスポットが見つかりません。");
    const restored = { ...baseline };
    if (spots[index].imageUrl) restored.imageUrl = spots[index].imageUrl;
    if (spots[index].imagePosition) restored.imagePosition = spots[index].imagePosition;
    spots[index] = restored;
    await writeJsonIfChanged(spotsPath, spots);
  });
}

async function saveMedia(payload) {
  if (!payload || typeof payload !== "object") throw new AdminError("画像データが正しくありません。");
  const contentType = String(payload.contentType || "");
  const extension = new Map([["image/webp", "webp"], ["image/jpeg", "jpg"]]).get(contentType);
  if (!extension) throw new AdminError("公開用画像はWebPまたはJPEGにしてください。");
  const base64 = String(payload.derivativeBase64 || "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AdminError("公開用画像を読み込めません。");
  const imageBytes = Buffer.from(base64, "base64");
  if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024) throw new AdminError("公開用画像のサイズが正しくありません。");
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};

  return withWriteLock(async () => {
    const spots = await readJson(spotsPath, []);
    const placement = metadata.placement === "hero" ? "hero" : "spot";
    const spotId = placement === "spot" ? String(metadata.spotId || "") : "";
    const spot = spots.find((item) => item.id === spotId);
    if (placement === "spot" && !spot) throw new AdminError("配置するスポットを選んでください。");

    const assetId = randomBytes(8).toString("hex");
    const directory = spotId || "hero";
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
    const filename = `${timestamp}-${assetId}-watermarked.${extension}`;
    const imageUrl = `/photos/${directory}/${filename}`;
    const imagePath = safeChild(photosDirectory, `${directory}/${filename}`);
    if (!imagePath) throw new AdminError("画像の保存先が正しくありません。");
    const asset = {
      id: assetId,
      displayName: spot ? `${spot.name} 公開画像` : "タイトル背景",
      placement,
      spotId: spotId || null,
      createdAt: new Date().toISOString(),
      imageUrl,
      cropX: Number(metadata.cropX) || 50,
      cropY: Number(metadata.cropY) || 50,
      zoom: Number(metadata.zoom) || 1,
    };

    await writeBytesAtomic(imagePath, imageBytes);
    try {
      const media = await readJson(mediaPath, []);
      media.unshift(asset);
      if (spot) {
        spot.imageUrl = imageUrl;
        spot.imagePosition = "center center";
        await writeJsonIfChanged(spotsPath, spots);
      } else {
        const site = await readJson(sitePath, { heroImage: null, heroImages: [] });
        const heroImages = siteHeroImages(site);
        if (!heroImages.includes(imageUrl)) heroImages.push(imageUrl);
        updateSiteHeroImages(site, heroImages);
        await writeJsonIfChanged(sitePath, site);
      }
      await writeJsonIfChanged(mediaPath, media);
    } catch (error) {
      await rm(imagePath, { force: true });
      throw error;
    }
    return serializeAsset(asset, placement === "hero" ? new Set([imageUrl]) : undefined);
  });
}

async function setMediaHeroCandidate(assetId, enabled) {
  if (!assetIdPattern.test(assetId)) throw new AdminError("画像IDが正しくありません。");
  if (typeof enabled !== "boolean") throw new AdminError("トップ画像候補の設定が正しくありません。");

  return withWriteLock(async () => {
    const media = await readJson(mediaPath, []);
    const asset = media.find((item) => item.id === assetId);
    if (!asset) throw new AdminError("画像が見つかりません。");
    const imageUrl = String(asset.imageUrl || "");
    if (!imageUrl.startsWith("/photos/")) throw new AdminError("公開用画像の場所が正しくありません。");

    const site = await readJson(sitePath, { heroImage: null, heroImages: [] });
    const currentHeroImages = siteHeroImages(site);
    let nextHeroImages = currentHeroImages;
    if (enabled) {
      nextHeroImages = currentHeroImages.includes(imageUrl)
        ? currentHeroImages
        : [...currentHeroImages, imageUrl];
    } else {
      if (currentHeroImages.includes(imageUrl) && currentHeroImages.length <= 1) {
        throw new AdminError("トップ画像は1枚以上残してください。");
      }
      nextHeroImages = currentHeroImages.filter((current) => current !== imageUrl);
    }

    updateSiteHeroImages(site, nextHeroImages);
    await writeJsonIfChanged(sitePath, site);
    return serializeAsset(asset, new Set(nextHeroImages));
  });
}

async function deleteMedia(assetId) {
  if (!assetIdPattern.test(assetId)) throw new AdminError("画像IDが正しくありません。");
  return withWriteLock(async () => {
    const media = await readJson(mediaPath, []);
    const asset = media.find((item) => item.id === assetId);
    if (!asset) throw new AdminError("画像が見つかりません。");
    const imageUrl = String(asset.imageUrl || "");
    const site = await readJson(sitePath, { heroImage: null, heroImages: [] });
    const currentHeroImages = siteHeroImages(site);
    if (currentHeroImages.includes(imageUrl) && currentHeroImages.length <= 1) {
      throw new AdminError("最後のトップ画像候補は削除できません。先に別の候補を追加してください。");
    }
    if (imageUrl.startsWith("/photos/")) {
      const imagePath = safeChild(photosDirectory, imageUrl.slice("/photos/".length));
      if (imagePath) await rm(imagePath, { force: true });
    }
    const nextMedia = media.filter((item) => item.id !== assetId);
    const spots = await readJson(spotsPath, []);
    let spotsChanged = false;
    for (const spot of spots) {
      if (spot.imageUrl === imageUrl) {
        const replacement = nextMedia.find((item) =>
          item.placement === "spot" && item.spotId === spot.id && item.imageUrl,
        );
        if (replacement) {
          spot.imageUrl = replacement.imageUrl;
          spot.imagePosition = "center center";
        } else {
          delete spot.imageUrl;
          delete spot.imagePosition;
        }
        spotsChanged = true;
      }
    }
    const nextHeroImages = currentHeroImages.filter((current) => current !== imageUrl);
    const siteChanged = nextHeroImages.length !== currentHeroImages.length;
    if (siteChanged) updateSiteHeroImages(site, nextHeroImages);
    await writeJsonIfChanged(mediaPath, nextMedia);
    if (spotsChanged) await writeJsonIfChanged(spotsPath, spots);
    if (siteChanged) await writeJsonIfChanged(sitePath, site);
  });
}

function requireLocal(request, response) {
  if (isLocalRequest(request)) return true;
  sendJson(response, { error: "この管理画面はPC本体または同じプライベートネットワークからのみ利用できます。" }, 403);
  return false;
}

function requireWriteAccess(request, response) {
  if (!requireLocal(request, response)) return false;
  if (safeCompare(request.headers["x-local-admin-token"] || "", writeToken)) return true;
  sendJson(response, { error: "編集操作の認証に失敗しました。画面を再読み込みしてください。" }, 403);
  return false;
}

function configuredRouteUsageUrl() {
  const explicit = String(process.env.ROUTE_USAGE_API_URL ?? "").trim();
  if (explicit) return explicit;
  const routeApiUrl = String(process.env.VITE_ROUTE_API_URL ?? "").trim();
  return routeApiUrl.replace(/\/api\/routes\/plan\/?$/, "/api/admin/route-usage");
}

async function proxyRouteUsage(response) {
  const endpoint = configuredRouteUsageUrl();
  const token = String(process.env.ROUTE_USAGE_ADMIN_TOKEN ?? "").trim();
  if (!endpoint || !token) {
    sendJson(response, {
      available: false,
      message:
        ".env.localへROUTE_USAGE_API_URLとROUTE_USAGE_ADMIN_TOKENを設定すると、本番サーバーの集計を表示できます。",
    });
    return;
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    sendJson(response, { error: "API使用状況の取得先URLが正しくありません。" }, 500);
    return;
  }
  if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
    sendJson(response, { error: "API使用状況の取得先にはHTTPSを指定してください。" }, 500);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(parsed, {
      headers: { "x-route-usage-admin-token": token },
      signal: controller.signal,
    });
    const result = await upstream.json().catch(() => ({}));
    sendJson(
      response,
      upstream.ok ? result : { error: result.error || "本番サーバーから使用状況を取得できませんでした。" },
      upstream.status,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function communityReviewNote(value) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, "審査メモ", 500);
}

function communitySubmissionById(submissions, submissionId) {
  if (!submissionIdPattern.test(submissionId)) {
    throw new AdminError("投稿IDが正しくありません。");
  }
  const submission = submissions.find((item) => item?.id === submissionId);
  if (!submission) throw new AdminError("投稿が見つかりません。");
  return submission;
}

async function readCommunityImage(submission) {
  const relative = typeof submission.imageKey === "string" ? submission.imageKey : "";
  const imagePath = safeChild(communitySubmissionsDirectory, relative);
  if (!imagePath || path.extname(imagePath).toLowerCase() !== ".webp") {
    throw new AdminError("投稿画像の保存先が正しくありません。");
  }
  let bytes;
  try {
    bytes = await readFile(imagePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new AdminError("投稿画像が見つかりません。");
    throw error;
  }
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
    throw new AdminError("投稿画像のサイズが正しくありません。");
  }
  const expectedHash = String(submission.imageSha256 || "");
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (!expectedHash || !safeCompare(actualHash, expectedHash)) {
    throw new AdminError("投稿画像の整合性を確認できませんでした。");
  }
  return bytes;
}

function escapeSvgText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function createAttributedCommunityImage(imageBytes, creditName) {
  const { default: sharp } = await import("sharp");
  const input = sharp(imageBytes, { failOn: "error", animated: false });
  const metadata = await input.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new AdminError("投稿画像の大きさを確認できませんでした。");
  const fontSize = Math.max(18, Math.min(42, Math.round(width * 0.024)));
  const padding = Math.max(12, Math.round(fontSize * 0.72));
  const bandHeight = fontSize + padding * 2;
  const label = escapeSvgText(`写真：${requiredText(creditName, "写真の掲載名", 60)}`);
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="${height - bandHeight}" width="${width}" height="${bandHeight}" fill="#0f172a" fill-opacity="0.72"/>` +
      `<text x="${width - padding}" y="${height - padding}" text-anchor="end" fill="white" ` +
      `font-family="Yu Gothic, Noto Sans JP, sans-serif" font-size="${fontSize}" font-weight="700">${label}</text>` +
      `</svg>`,
  );
  return input
    .composite([{ input: overlay, top: 0, left: 0 }])
    .webp({ quality: 84, effort: 4 })
    .toBuffer();
}

function communityPhotoAsset(submission, spot, assetId, imageUrl, createdAt) {
  const creditName = requiredText(submission.creditName, "写真の掲載名", 60);
  return {
    id: assetId,
    displayName: `${spot.name} 投稿写真（${creditName}）`,
    placement: "spot",
    spotId: spot.id,
    createdAt,
    imageUrl,
    cropX: 50,
    cropY: 50,
    zoom: 1,
    creditName,
    source: "community",
    submissionId: submission.id,
  };
}

async function rejectCommunitySubmission(submissionId, payload) {
  return withCommunitySubmissionIndex(async (submissions) => {
    const submission = communitySubmissionById(submissions, submissionId);
    if (submission.status !== "pending") {
      throw new AdminError("この投稿はすでに審査済みです。");
    }
    submission.status = "rejected";
    submission.reviewedAt = new Date().toISOString();
    submission.reviewedBy = "local-admin";
    submission.reviewNote = communityReviewNote(payload?.reviewNote);
    return serializeCommunitySubmission(submission);
  });
}

async function importCommunitySubmission(submissionId, payload) {
  return withCommunitySubmissionIndex(async (submissions) => {
    const submission = communitySubmissionById(submissions, submissionId);
    if (submission.status !== "pending") {
      throw new AdminError("この投稿はすでに審査済みです。");
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const spots = await readJson(spotsPath, []);
    const media = await readJson(mediaPath, []);
    const transitNames = await readJson(transitNamesPath, {});
    if (!Array.isArray(spots) || !Array.isArray(media) || !transitNames || typeof transitNames !== "object") {
      throw new AdminError("公開データを読み込めませんでした。");
    }

    let importedSpot;
    let asset;
    let publicImagePath = "";
    const originalSpots = structuredClone(spots);
    const originalMedia = structuredClone(media);
    const originalTransitNames = structuredClone(transitNames);

    try {
      if (submission.kind === "photo") {
        const spotId = requiredText(payload?.spotId, "取り込み先スポット", 80);
        if (!spotIdPattern.test(spotId)) throw new AdminError("取り込み先スポットが正しくありません。");
        const spot = spots.find((item) => item.id === spotId);
        if (!spot) throw new AdminError("取り込み先スポットが見つかりません。");
        const imageBytes = await createAttributedCommunityImage(
          await readCommunityImage(submission),
          submission.creditName,
        );
        const assetId = randomBytes(8).toString("hex");
        const timestamp = createdAt.replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
        const filename = `${timestamp}-${assetId}-community.webp`;
        const imageUrl = `/photos/${spot.id}/${filename}`;
        publicImagePath = safeChild(photosDirectory, `${spot.id}/${filename}`) || "";
        if (!publicImagePath) throw new AdminError("公開画像の保存先が正しくありません。");
        asset = communityPhotoAsset(submission, spot, assetId, imageUrl, createdAt);
        media.unshift(asset);
        if (!spot.imageUrl) {
          spot.imageUrl = imageUrl;
          spot.imagePosition = "center center";
        }
        await writeBytesAtomic(publicImagePath, imageBytes);
      } else if (submission.kind === "spot") {
        const requestedSpot = payload?.spot;
        if (!requestedSpot || typeof requestedSpot !== "object" || Array.isArray(requestedSpot)) {
          throw new AdminError("スポット情報が正しくありません。");
        }
        const spotId = requiredText(requestedSpot.id, "スポットID", 80);
        if (!spotIdPattern.test(spotId)) throw new AdminError("スポットIDが正しくありません。");
        if (spots.some((item) => item.id === spotId)) throw new AdminError("同じスポットIDがすでにあります。");
        importedSpot = validateSpot(requestedSpot, spotId, {});
        const transitSearchName = requiredText(
          requestedSpot.transitSearchName || requestedSpot.name,
          "経路検索名",
          160,
        );

        if (submission.imageKey) {
          const imageBytes = await createAttributedCommunityImage(
            await readCommunityImage(submission),
            submission.creditName,
          );
          const assetId = randomBytes(8).toString("hex");
          const timestamp = createdAt.replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
          const filename = `${timestamp}-${assetId}-community.webp`;
          const imageUrl = `/photos/${spotId}/${filename}`;
          publicImagePath = safeChild(photosDirectory, `${spotId}/${filename}`) || "";
          if (!publicImagePath) throw new AdminError("公開画像の保存先が正しくありません。");
          asset = communityPhotoAsset(submission, importedSpot, assetId, imageUrl, createdAt);
          importedSpot.imageUrl = imageUrl;
          importedSpot.imagePosition = "center center";
          media.unshift(asset);
          await writeBytesAtomic(publicImagePath, imageBytes);
        }
        spots.push(importedSpot);
        transitNames[spotId] = transitSearchName;
      } else {
        throw new AdminError("投稿の種類が正しくありません。");
      }

      await writeJsonIfChanged(spotsPath, spots);
      await writeJsonIfChanged(mediaPath, media);
      await writeJsonIfChanged(transitNamesPath, transitNames);

      submission.status = "imported";
      submission.reviewedAt = createdAt;
      submission.reviewedBy = "local-admin";
      submission.reviewNote = communityReviewNote(payload?.reviewNote);
      const result = {
        submission: serializeCommunitySubmission(submission),
        spot: importedSpot,
        asset: asset ? serializeAsset(asset) : undefined,
      };

      // 公開データと審査状態を同じ失敗境界に置きます。審査状態の保存に
      // 失敗した場合は catch 側で公開データも元に戻し、再取り込みによる
      // 二重登録を防ぎます。外側の保存は同内容のため no-op になります。
      await writeJsonIfChanged(communitySubmissionIndexPath, submissions);
      return result;
    } catch (error) {
      if (publicImagePath) await rm(publicImagePath, { force: true }).catch(() => undefined);
      await writeJsonIfChanged(spotsPath, originalSpots).catch(() => undefined);
      await writeJsonIfChanged(mediaPath, originalMedia).catch(() => undefined);
      await writeJsonIfChanged(transitNamesPath, originalTransitNames).catch(() => undefined);
      throw error;
    }
  });
}

async function requestHandler(request, response, initialSpots) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  const pathname = decodeURIComponent(requestUrl.pathname);

  try {
    if (pathname.startsWith("/api/admin/")) {
      if (request.method === "GET") {
        if (!requireLocal(request, response)) return;
        if (pathname === "/api/admin/identity") {
          sendJson(response, { application: adminApplicationId, schemaVersion: 1 });
          return;
        }
        const submissionImageMatch = pathname.match(
          /^\/api\/admin\/submissions\/([a-f0-9-]+)\/image$/i,
        );
        if (submissionImageMatch) {
          const submissions = await readCommunitySubmissions();
          const submission = communitySubmissionById(submissions, submissionImageMatch[1]);
          const imagePath = safeChild(
            communitySubmissionsDirectory,
            typeof submission.imageKey === "string" ? submission.imageKey : "",
          );
          if (!imagePath) {
            sendJson(response, { error: "投稿画像が見つかりません。" }, 404);
            return;
          }
          await sendFile(response, imagePath);
          return;
        }
        if (pathname === "/api/admin/state") {
          const [spots, media, site, communitySubmissions] = await Promise.all([
            readJson(spotsPath, []),
            readJson(mediaPath, []),
            readJson(sitePath, { heroImage: null, heroImages: [] }),
            readCommunitySubmissions(),
          ]);
          const heroImageSet = new Set(siteHeroImages(site));
          sendJson(response, {
            spots,
            assets: media.map((asset) => serializeAsset(asset, heroImageSet)),
            submissions: communitySubmissions
              .map(serializeCommunitySubmission)
              .sort((left, right) => {
                if (left.status === "pending" && right.status !== "pending") return -1;
                if (left.status !== "pending" && right.status === "pending") return 1;
                return right.createdAt.localeCompare(left.createdAt);
              }),
            siteVersion: normalizedSiteVersion(site.version),
            writeToken,
            lanUrl: lanAdminUrl,
          });
          return;
        }
        if (pathname === "/api/admin/publish-status") {
          sendJson(response, { ...gitStatus(), publishToken: writeToken });
          return;
        }
        if (pathname === "/api/admin/route-usage") {
          await proxyRouteUsage(response);
          return;
        }
      }

      if (request.method === "PUT" && pathname.startsWith("/api/admin/spots/")) {
        if (!requireWriteAccess(request, response)) return;
        const spotId = pathname.slice("/api/admin/spots/".length);
        sendJson(response, { spot: await updateSpot(spotId, await readJsonBody(request, 1024 * 1024)) });
        return;
      }

      if (request.method === "PUT" && pathname === "/api/admin/site-version") {
        if (!requireWriteAccess(request, response)) return;
        const version = await updateSiteVersion(await readJsonBody(request, 32 * 1024));
        sendJson(response, { version });
        return;
      }

      if (request.method === "DELETE" && pathname.startsWith("/api/admin/spots/")) {
        if (!requireWriteAccess(request, response)) return;
        await resetSpot(pathname.slice("/api/admin/spots/".length), initialSpots);
        sendEmpty(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/admin/media") {
        if (!requireWriteAccess(request, response)) return;
        sendJson(response, { asset: await saveMedia(await readJsonBody(request)) }, 201);
        return;
      }

      const rejectSubmissionMatch = pathname.match(
        /^\/api\/admin\/submissions\/([a-f0-9-]+)\/reject$/i,
      );
      if (request.method === "POST" && rejectSubmissionMatch) {
        if (!requireWriteAccess(request, response)) return;
        const submission = await rejectCommunitySubmission(
          rejectSubmissionMatch[1],
          await readJsonBody(request, 64 * 1024),
        );
        sendJson(response, { submission });
        return;
      }

      const importSubmissionMatch = pathname.match(
        /^\/api\/admin\/submissions\/([a-f0-9-]+)\/import$/i,
      );
      if (request.method === "POST" && importSubmissionMatch) {
        if (!requireWriteAccess(request, response)) return;
        sendJson(
          response,
          await importCommunitySubmission(
            importSubmissionMatch[1],
            await readJsonBody(request, 256 * 1024),
          ),
        );
        return;
      }

      if (request.method === "DELETE" && pathname.startsWith("/api/admin/media/")) {
        if (!requireWriteAccess(request, response)) return;
        await deleteMedia(pathname.slice("/api/admin/media/".length));
        sendEmpty(response);
        return;
      }

      if (
        request.method === "PATCH" &&
        pathname.startsWith("/api/admin/media/") &&
        pathname.endsWith("/hero-candidate")
      ) {
        if (!requireWriteAccess(request, response)) return;
        const suffix = "/hero-candidate";
        const assetId = pathname.slice("/api/admin/media/".length, -suffix.length);
        const body = await readJsonBody(request, 32 * 1024);
        sendJson(response, { asset: await setMediaHeroCandidate(assetId, body.enabled) });
        return;
      }

      if (request.method === "POST" && pathname === "/api/admin/publish") {
        if (!requireLocal(request, response)) return;
        const body = await readJsonBody(request, 1024 * 1024);
        if (!safeCompare(body.publishToken || "", writeToken)) {
          sendJson(response, { error: "公開操作の認証に失敗しました。" }, 403);
          return;
        }
        sendJson(response, await publishToGitHub());
        return;
      }

      if (request.method === "POST" && pathname === "/api/admin/shutdown") {
        if (!requireWriteAccess(request, response)) return;
        response.once("finish", () => {
          setTimeout(() => {
            console.log("Hasunosora Admin: stopped from the admin page.");
            server.close(() => process.exit(0));
            server.closeIdleConnections?.();
          }, 100);
        });
        sendJson(response, { stopped: true });
        return;
      }

      sendJson(response, { error: "APIが見つかりません。" }, 404);
      return;
    }

    if (pathname === "/") {
      response.writeHead(302, { location: "/admin/" });
      response.end();
      return;
    }
    if (pathname === "/admin") {
      response.writeHead(301, { location: "/admin/" });
      response.end();
      return;
    }
    if (pathname.startsWith("/admin/")) {
      const relative = pathname.slice("/admin/".length) || "index.html";
      await sendFile(response, safeChild(adminDirectory, relative));
      return;
    }
    if (pathname.startsWith("/photos/")) {
      await sendFile(response, safeChild(photosDirectory, pathname.slice("/photos/".length)));
      return;
    }
    sendJson(response, { error: "ページが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AdminError) {
      sendJson(response, { error: error.message }, 400);
    } else {
      console.error(error);
      sendJson(response, { error: "ローカル管理処理に失敗しました。" }, 500);
    }
  }
}

function parseArguments() {
  const values = { bind: "127.0.0.1", port: 8766 };
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--bind") values.bind = process.argv[++index] || values.bind;
    else if (process.argv[index] === "--port") values.port = Number(process.argv[++index]) || values.port;
  }
  return values;
}

const options = parseArguments();
if (!isLoopback(options.bind) && options.bind !== "0.0.0.0") {
  throw new Error("管理サーバーの待受アドレスが正しくありません。");
}
const lanAddress = findLanAddress();
const lanAdminUrl = lanAddress ? `http://${lanAddress}:${options.port}/admin/` : "";
const initialSpots = await readJson(spotsPath, []);
await readFile(path.join(adminDirectory, "index.html"));
const server = createServer((request, response) => {
  void requestHandler(request, response, initialSpots);
});
server.listen(options.port, options.bind, () => {
  console.log(`Hasunosora Admin (PC): http://127.0.0.1:${options.port}/admin/`);
  if (lanAdminUrl) console.log(`Hasunosora Admin (same Wi-Fi): ${lanAdminUrl}`);
});
