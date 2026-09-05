import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommunitySubmissionValidationError,
  parseCommunityCreditName,
  parseCommunitySubmissionKind,
  parseCommunitySubmissionPayload,
} from "./app/community-submissions.ts";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(projectDirectory, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const maximumImageBytes = 15 * 1024 * 1024;
const maximumRequestBytes = maximumImageBytes + 256 * 1024;
const maximumPublicImageBytes = 8 * 1024 * 1024;
const maximumPayloadCharacters = 16_000;
const maximumDailySubmissions = 5;
const maximumConcurrentSubmissions = 4;
const minimumFormDurationMs = 3_000;
const maximumFormDurationMs = 24 * 60 * 60 * 1_000;
const fileLockTimeoutMs = 5_000;
const staleFileLockMs = 120_000;
const turnstileVerificationTimeoutMs = 10_000;
const turnstileVerificationMaximumAttempts = 2;
const turnstileVerificationRetryDelayMs = 1_000;
const turnstileDiagnosticMaximumBytes = 512 * 1024;
const turnstileDiagnosticMaximumBackups = 3;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedTurnstileDiagnosticReasons = new Set([
  "network_error",
  "timeout",
  "http_error",
  "invalid_response",
  "service_error",
  "rejected",
]);
const allowedTurnstileServiceErrorCodes = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "missing-input-response",
  "invalid-input-response",
  "bad-request",
  "timeout-or-duplicate",
  "internal-error",
]);
const allowedTurnstileNetworkErrorCodes = new Set([
  "ABORT_ERR",
  "CERT_HAS_EXPIRED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_PROXY_TUNNEL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class CommunityRequestError extends Error {
  constructor(status, message, code = "INVALID_REQUEST") {
    super(message);
    this.name = "CommunityRequestError";
    this.status = status;
    this.code = code;
  }
}

let fileWriteQueue = Promise.resolve();
let turnstileDiagnosticWriteQueue = Promise.resolve();
let activeSubmissionRequests = 0;

function withFileWriteLock(task) {
  const result = fileWriteQueue.then(task, task);
  fileWriteQueue = result.catch(() => undefined);
  return result;
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isLocalDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function parsePort(value) {
  const port = Number(value || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("COMMUNITY_SERVER_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function parseRetentionDays(value) {
  const days = Number(value || 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("COMMUNITY_RETENTION_DAYS must be an integer from 1 to 365.");
  }
  return days;
}

export function loadCommunityServerConfig(environment = process.env) {
  const allowedOrigins = new Set(
    String(environment.COMMUNITY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => normalizeOrigin(origin.trim()))
      .filter(Boolean),
  );
  return {
    host: "127.0.0.1",
    port: parsePort(environment.COMMUNITY_SERVER_PORT),
    allowedOrigins,
    submissionsDirectory: path.resolve(
      environment.COMMUNITY_SUBMISSIONS_DIRECTORY ||
        path.join(projectDirectory, "private", "community-submissions"),
    ),
    turnstileSecret: String(environment.TURNSTILE_SECRET_KEY ?? "").trim(),
    rateLimitSecret: String(environment.COMMUNITY_RATE_LIMIT_SECRET ?? "").trim(),
    consentVersion: String(environment.COMMUNITY_CONSENT_VERSION ?? "2026-09-04").trim(),
    retentionDays: parseRetentionDays(environment.COMMUNITY_RETENTION_DAYS),
    allowLocalTurnstileBypass: environment.NODE_ENV !== "production",
  };
}

export function validateCommunityServerConfig(config) {
  if (!(config.allowedOrigins instanceof Set) || config.allowedOrigins.size < 1) {
    throw new Error("COMMUNITY_ALLOWED_ORIGINS must include the public site origin.");
  }
  if (!config.rateLimitSecret || config.rateLimitSecret.length < 24) {
    throw new Error("COMMUNITY_RATE_LIMIT_SECRET must contain at least 24 characters.");
  }
  const hasPublicOrigin = [...config.allowedOrigins].some(
    (origin) => !isLocalDevelopmentOrigin(origin),
  );
  if (!config.turnstileSecret && (hasPublicOrigin || !config.allowLocalTurnstileBypass)) {
    throw new Error("TURNSTILE_SECRET_KEY is required for a public submission origin.");
  }
  return config;
}

function normalizedDiagnosticDate(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
}

function normalizedDiagnosticInteger(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function normalizedDiagnosticCheck(value) {
  return typeof value === "boolean" ? value : null;
}

function turnstileNetworkErrorCode(error) {
  const rawCode = typeof error?.cause?.code === "string"
    ? error.cause.code
    : typeof error?.code === "string"
      ? error.code
      : "";
  if (allowedTurnstileNetworkErrorCodes.has(rawCode)) return rawCode;
  return rawCode ? "OTHER" : null;
}

function isTurnstileTimeout(error) {
  return error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    error?.cause?.code === "ETIMEDOUT" ||
    error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT";
}

export function sanitizeTurnstileDiagnostic(diagnostic, now = new Date()) {
  const rawServiceErrorCodes = Array.isArray(diagnostic?.serviceErrorCodes)
    ? diagnostic.serviceErrorCodes
    : [];
  const serviceErrorCodes = Array.from(new Set(rawServiceErrorCodes.filter(
    (code) => typeof code === "string" && allowedTurnstileServiceErrorCodes.has(code),
  )));
  const reason = allowedTurnstileDiagnosticReasons.has(diagnostic?.reason)
    ? diagnostic.reason
    : "network_error";
  const rawNetworkErrorCode = typeof diagnostic?.networkErrorCode === "string"
    ? diagnostic.networkErrorCode
    : "";
  return {
    schemaVersion: 1,
    occurredAt: normalizedDiagnosticDate(now).toISOString(),
    event: "turnstile_verification_failed",
    reason,
    httpStatus: normalizedDiagnosticInteger(diagnostic?.httpStatus, 100, 599),
    durationMs: normalizedDiagnosticInteger(diagnostic?.durationMs, 0, 60_000),
    attemptCount: normalizedDiagnosticInteger(
      diagnostic?.attemptCount,
      1,
      turnstileVerificationMaximumAttempts,
    ),
    networkErrorCode: allowedTurnstileNetworkErrorCodes.has(rawNetworkErrorCode)
      ? rawNetworkErrorCode
      : rawNetworkErrorCode
        ? "OTHER"
        : null,
    serviceErrorCodes,
    hasUnknownServiceErrorCode: diagnostic?.hasUnknownServiceErrorCode === true ||
      rawServiceErrorCodes.some(
        (code) => typeof code !== "string" || !allowedTurnstileServiceErrorCodes.has(code),
      ),
    checks: {
      success: normalizedDiagnosticCheck(
        diagnostic?.checks?.success ?? diagnostic?.successCheck,
      ),
      action: normalizedDiagnosticCheck(
        diagnostic?.checks?.action ?? diagnostic?.actionCheck,
      ),
      hostname: normalizedDiagnosticCheck(
        diagnostic?.checks?.hostname ?? diagnostic?.hostnameCheck,
      ),
    },
  };
}

export function turnstileDiagnosticLogPath(config) {
  return path.join(
    path.resolve(config.submissionsDirectory),
    "diagnostics",
    "turnstile-failures.jsonl",
  );
}

async function rotateTurnstileDiagnosticLog(logPath, maximumBackups) {
  for (let index = maximumBackups; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const destination = `${logPath}.${index}`;
    await rm(destination, { force: true });
    try {
      await rename(source, destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function appendTurnstileFailureDiagnostic(config, diagnostic, options = {}) {
  const maximumBytes = normalizedDiagnosticInteger(
    options.maximumBytes ?? turnstileDiagnosticMaximumBytes,
    256,
    5 * 1024 * 1024,
  ) ?? turnstileDiagnosticMaximumBytes;
  const maximumBackups = normalizedDiagnosticInteger(
    options.maximumBackups ?? turnstileDiagnosticMaximumBackups,
    1,
    10,
  ) ?? turnstileDiagnosticMaximumBackups;
  const diagnosticDate = options.now ??
    (typeof diagnostic?.occurredAt === "string" ? new Date(diagnostic.occurredAt) : new Date());
  const entry = sanitizeTurnstileDiagnostic(diagnostic, diagnosticDate);
  const line = `${JSON.stringify(entry)}\n`;
  const logPath = turnstileDiagnosticLogPath(config);
  const task = async () => {
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const existingSize = await stat(logPath).then((details) => details.size).catch((error) => {
      if (error?.code === "ENOENT") return 0;
      throw error;
    });
    if (existingSize > 0 && existingSize + Buffer.byteLength(line) > maximumBytes) {
      await rotateTurnstileDiagnosticLog(logPath, maximumBackups);
    }
    await appendFile(logPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    return entry;
  };
  const result = turnstileDiagnosticWriteQueue.then(task, task);
  turnstileDiagnosticWriteQueue = result.catch(() => undefined);
  return result;
}

async function tryRecordTurnstileFailure(recordFailure, diagnostic) {
  if (typeof recordFailure !== "function") return;
  try {
    await recordFailure(sanitizeTurnstileDiagnostic(diagnostic));
  } catch {
    console.error("Turnstile diagnostic log write failed");
  }
}

export function pruneReviewedCommunitySubmissions(submissions, now, retentionDays) {
  const threshold = now.getTime() - retentionDays * 86_400_000;
  const retained = [];
  const removedImageKeys = [];
  for (const submission of submissions) {
    const terminal = submission?.status === "rejected" || submission?.status === "imported";
    const reviewedAt = Date.parse(String(submission?.reviewedAt ?? ""));
    if (terminal && Number.isFinite(reviewedAt) && reviewedAt < threshold) {
      if (typeof submission.imageKey === "string") removedImageKeys.push(submission.imageKey);
      continue;
    }
    retained.push(submission);
  }
  return { submissions: retained, removedImageKeys };
}

export function isAllowedSubmissionOrigin(origin, config) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return config.allowedOrigins.has(normalized) ||
    (config.allowLocalTurnstileBypass && isLocalDevelopmentOrigin(normalized));
}

function securityHeaders(origin = "") {
  const headers = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
}

function sendJson(response, status, value, origin = "") {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    ...securityHeaders(origin),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendPreflight(response, origin) {
  response.writeHead(204, {
    ...securityHeaders(origin),
    "access-control-allow-headers": "Content-Type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
  });
  response.end();
}

function singleHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : String(value ?? "");
}

function normalizeIpAddress(value) {
  const address = String(value ?? "").trim();
  const mappedIpv4 = address.toLowerCase().startsWith("::ffff:")
    ? address.slice(7)
    : "";
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  return isIP(address) ? address : "";
}

function isLoopbackAddress(value) {
  const address = normalizeIpAddress(value);
  if (address === "::1") return true;
  return isIP(address) === 4 && address.split(".")[0] === "127";
}

export function clientAddress(request) {
  const socketAddress = normalizeIpAddress(request.socket.remoteAddress);
  if (isLoopbackAddress(socketAddress)) {
    const forwardedAddresses = singleHeader(request, "x-forwarded-for")
      .split(",")
      .map((address) => normalizeIpAddress(address))
      .filter(Boolean);
    const forwardedAddress = forwardedAddresses.at(-1);
    if (forwardedAddress) return forwardedAddress;
  }
  return socketAddress || "unknown";
}

export function makeDailyRateKey(ipAddress, date, secret) {
  if (!secret) {
    throw new CommunityRequestError(
      503,
      "投稿受付の安全設定が完了していません。",
      "RATE_LIMIT_NOT_CONFIGURED",
    );
  }
  const day = date.toISOString().slice(0, 10);
  return createHash("sha256")
    .update(`${secret}\u0000${day}\u0000${ipAddress}`)
    .digest("hex");
}

function detectImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

export function validateUploadedImage(bytes, declaredType = "") {
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new CommunityRequestError(400, "画像を選択してください。", "IMAGE_REQUIRED");
  }
  if (bytes.length > maximumImageBytes) {
    throw new CommunityRequestError(
      413,
      "画像は15MB以下にしてください。",
      "IMAGE_TOO_LARGE",
    );
  }
  const detectedType = detectImageType(bytes);
  if (!allowedImageTypes.has(detectedType)) {
    throw new CommunityRequestError(
      400,
      "JPEG、PNG、WebPの画像を選んでください。",
      "UNSUPPORTED_IMAGE",
    );
  }
  if (declaredType && declaredType !== "application/octet-stream" && declaredType !== detectedType) {
    throw new CommunityRequestError(
      400,
      "画像の形式が正しくありません。",
      "IMAGE_TYPE_MISMATCH",
    );
  }
  return detectedType;
}

export async function reencodeCommunityImage(bytes) {
  validateUploadedImage(bytes);
  const { default: sharp } = await import("sharp");
  let output;
  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1) {
      throw new CommunityRequestError(
        400,
        "アニメーション画像は投稿できません。",
        "ANIMATED_IMAGE",
      );
    }
    output = await image
      .rotate()
      .resize({
        width: 2560,
        height: 2560,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 84, effort: 4 })
      .toBuffer();
  } catch (error) {
    if (error instanceof CommunityRequestError) throw error;
    throw new CommunityRequestError(
      400,
      "画像を読み込めませんでした。別の画像をお試しください。",
      "IMAGE_DECODE_FAILED",
    );
  }
  if (!output.length || output.length > maximumPublicImageBytes) {
    throw new CommunityRequestError(
      413,
      "画像を処理できませんでした。より小さい画像をお試しください。",
      "ENCODED_IMAGE_TOO_LARGE",
    );
  }
  return output;
}

async function readRequestBody(request, maximumBytes = maximumRequestBytes) {
  const declaredLength = Number(singleHeader(request, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CommunityRequestError(413, "送信データが大きすぎます。", "BODY_TOO_LARGE");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new CommunityRequestError(413, "送信データが大きすぎます。", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function parseMultipartForm(request) {
  const contentType = singleHeader(request, "content-type").toLowerCase();
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new CommunityRequestError(
      415,
      "multipart/form-data形式で送信してください。",
      "UNSUPPORTED_CONTENT_TYPE",
    );
  }
  const body = await readRequestBody(request);
  try {
    const webRequest = new Request("http://127.0.0.1/api/submissions", {
      method: "POST",
      headers: requestHeaders(request),
      body,
    });
    return await webRequest.formData();
  } catch {
    throw new CommunityRequestError(
      400,
      "投稿データを読み込めませんでした。",
      "INVALID_MULTIPART",
    );
  }
}

function requiredFormText(form, name, label, maximumLength = 10_000) {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new CommunityRequestError(400, `${label}が必要です。`, "MISSING_FIELD");
  }
  const text = value.trim();
  if (text.length > maximumLength) {
    throw new CommunityRequestError(400, `${label}が長すぎます。`, "FIELD_TOO_LONG");
  }
  return text;
}

function optionalFormText(form, name, maximumLength = 10_000) {
  const value = form.get(name);
  if (value === null) return "";
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new CommunityRequestError(400, "投稿データが正しくありません。", "INVALID_FIELD");
  }
  return value.trim();
}

function validateBotFields(form, now) {
  if (optionalFormText(form, "website", 200)) {
    throw new CommunityRequestError(400, "投稿を受け付けられませんでした。", "HONEYPOT");
  }
  const startedAtText = requiredFormText(form, "startedAt", "入力開始時刻", 32);
  const startedAt = Number(startedAtText);
  const elapsed = now.getTime() - startedAt;
  if (!Number.isFinite(startedAt) || elapsed < minimumFormDurationMs || elapsed > maximumFormDurationMs) {
    throw new CommunityRequestError(
      400,
      "入力内容を確認して、もう一度お試しください。",
      "INVALID_FORM_DURATION",
    );
  }
}

function isRetryableTurnstileStatus(status) {
  return status === 408 || status === 425 || status >= 500;
}

async function verifyTurnstile(
  token,
  ipAddress,
  origin,
  config,
  fetchImplementation,
  recordFailure,
) {
  if (!config.turnstileSecret) {
    throw new CommunityRequestError(
      503,
      "投稿受付の認証設定が完了していません。",
      "TURNSTILE_NOT_CONFIGURED",
    );
  }
  if (!token) {
    throw new CommunityRequestError(
      400,
      "投稿前の確認を完了してください。",
      "TURNSTILE_REQUIRED",
    );
  }
  const verificationBody = new URLSearchParams({
    secret: config.turnstileSecret,
    response: token,
    remoteip: ipAddress,
    idempotency_key: randomUUID(),
  });
  const allowedHostnames = new Set(
    [...config.allowedOrigins, origin]
      .map((allowedOrigin) => {
        try {
          return new URL(allowedOrigin).hostname.toLowerCase().replace(/\.$/, "");
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= turnstileVerificationMaximumAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImplementation(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: verificationBody,
          signal: AbortSignal.timeout(turnstileVerificationTimeoutMs),
        },
      );
    } catch (error) {
      if (attempt < turnstileVerificationMaximumAttempts) {
        await wait(turnstileVerificationRetryDelayMs);
        continue;
      }
      await tryRecordTurnstileFailure(recordFailure, {
        reason: isTurnstileTimeout(error) ? "timeout" : "network_error",
        durationMs: Date.now() - startedAt,
        attemptCount: attempt,
        networkErrorCode: turnstileNetworkErrorCode(error),
      });
      throw new CommunityRequestError(
        503,
        "投稿前の確認に接続できませんでした。少し待ってからお試しください。",
        "TURNSTILE_UNAVAILABLE",
      );
    }
    if (!response.ok) {
      if (
        attempt < turnstileVerificationMaximumAttempts &&
        isRetryableTurnstileStatus(response.status)
      ) {
        await response.body?.cancel().catch(() => undefined);
        await wait(turnstileVerificationRetryDelayMs);
        continue;
      }
      const failureResult = await response.json().catch(() => null);
      await tryRecordTurnstileFailure(recordFailure, {
        reason: "http_error",
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        attemptCount: attempt,
        serviceErrorCodes: failureResult?.["error-codes"],
      });
      throw new CommunityRequestError(
        503,
        "投稿前の確認に接続できませんでした。少し待ってからお試しください。",
        "TURNSTILE_UNAVAILABLE",
      );
    }

    let result;
    try {
      result = await response.json();
    } catch {
      if (attempt < turnstileVerificationMaximumAttempts) {
        await wait(turnstileVerificationRetryDelayMs);
        continue;
      }
      await tryRecordTurnstileFailure(recordFailure, {
        reason: "invalid_response",
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        attemptCount: attempt,
      });
      throw new CommunityRequestError(
        503,
        "投稿前の確認に接続できませんでした。少し待ってからお試しください。",
        "TURNSTILE_UNAVAILABLE",
      );
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.success !== "boolean"
    ) {
      if (attempt < turnstileVerificationMaximumAttempts) {
        await wait(turnstileVerificationRetryDelayMs);
        continue;
      }
      await tryRecordTurnstileFailure(recordFailure, {
        reason: "invalid_response",
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        attemptCount: attempt,
      });
      throw new CommunityRequestError(
        503,
        "投稿前の確認に接続できませんでした。少し待ってからお試しください。",
        "TURNSTILE_UNAVAILABLE",
      );
    }
    const verifiedHostname = typeof result.hostname === "string"
      ? result.hostname.toLowerCase().replace(/\.$/, "")
      : "";
    const successCheck = result.success === true;
    const actionCheck = result.action === "community_submission";
    const hostnameCheck = allowedHostnames.has(verifiedHostname);
    if (successCheck && actionCheck && hostnameCheck) return;

    const serviceErrorCodes = Array.isArray(result["error-codes"])
      ? result["error-codes"]
      : [];
    const isInternalServiceError = !successCheck && serviceErrorCodes.includes("internal-error");
    if (isInternalServiceError && attempt < turnstileVerificationMaximumAttempts) {
      await wait(turnstileVerificationRetryDelayMs);
      continue;
    }
    await tryRecordTurnstileFailure(recordFailure, {
      reason: isInternalServiceError ? "service_error" : "rejected",
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      attemptCount: attempt,
      serviceErrorCodes,
      successCheck,
      actionCheck,
      hostnameCheck,
    });
    throw new CommunityRequestError(
      isInternalServiceError ? 503 : 400,
      isInternalServiceError
        ? "投稿前の確認に接続できませんでした。少し待ってからお試しください。"
        : "投稿前の確認に失敗しました。画面を再読み込みしてお試しください。",
      isInternalServiceError ? "TURNSTILE_UNAVAILABLE" : "TURNSTILE_FAILED",
    );
  }

  throw new CommunityRequestError(
    503,
    "投稿前の確認に接続できませんでした。少し待ってからお試しください。",
    "TURNSTILE_UNAVAILABLE",
  );
}

async function readSubmissionIndex(indexPath) {
  try {
    const contents = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed)) throw new Error("Index is not an array.");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new CommunityRequestError(
      500,
      "投稿の保存領域を読み込めませんでした。",
      "INDEX_READ_FAILED",
    );
  }
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireSharedIndexLock(lockPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < fileLockTimeoutMs) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const lockToken = `${process.pid}:${randomUUID()}`;
      try {
        await handle.writeFile(`${lockToken}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        const currentToken = await readFile(lockPath, "utf8").catch(() => "");
        if (currentToken.trim() === lockToken) {
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > staleFileLockMs) {
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
  throw new CommunityRequestError(
    503,
    "投稿の保存処理が混み合っています。少し待ってからお試しください。",
    "INDEX_LOCK_TIMEOUT",
  );
}

export async function withCommunitySubmissionIndexLock(
  submissionsDirectory,
  task,
) {
  await mkdir(submissionsDirectory, { recursive: true, mode: 0o700 });
  const indexPath = path.join(submissionsDirectory, "index.json");
  const lockPath = `${indexPath}.lock`;
  return withFileWriteLock(async () => {
    const releaseLock = await acquireSharedIndexLock(lockPath);
    try {
      const submissions = await readSubmissionIndex(indexPath);
      const writeSubmissions = async (nextSubmissions) => {
        if (!Array.isArray(nextSubmissions)) {
          throw new TypeError("Community submission index must be an array.");
        }
        await atomicWrite(
          indexPath,
          `${JSON.stringify(nextSubmissions, null, 2)}\n`,
        );
      };
      return await task({ submissions, writeSubmissions, indexPath });
    } finally {
      await releaseLock();
    }
  });
}

export async function persistCommunitySubmission({
  config,
  submission,
  imageBytes,
}) {
  const imagesDirectory = path.join(config.submissionsDirectory, "images");
  await mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
  return withCommunitySubmissionIndexLock(
    config.submissionsDirectory,
    async ({ submissions, writeSubmissions }) => {
      const pruned = pruneReviewedCommunitySubmissions(
        submissions,
        new Date(submission.createdAt),
        config.retentionDays ?? 30,
      );
      const dailyCount = pruned.submissions.filter(
        (item) => item?.dailyRateKey === submission.dailyRateKey,
      ).length;
      if (dailyCount >= maximumDailySubmissions) {
        throw new CommunityRequestError(
          429,
          "本日の投稿上限に達しました。明日もう一度お試しください。",
          "DAILY_RATE_LIMIT",
        );
      }

      const imagePath = submission.imageKey
        ? path.join(config.submissionsDirectory, ...submission.imageKey.split("/"))
        : "";
      if (imagePath && imageBytes) await atomicWrite(imagePath, imageBytes);
      try {
        await writeSubmissions([...pruned.submissions, submission]);
      } catch (error) {
        if (imagePath) await rm(imagePath, { force: true }).catch(() => undefined);
        if (error instanceof CommunityRequestError) throw error;
        throw new CommunityRequestError(
          500,
          "投稿を保存できませんでした。",
          "INDEX_WRITE_FAILED",
        );
      }
      for (const imageKey of pruned.removedImageKeys) {
        const expiredImagePath = path.resolve(
          config.submissionsDirectory,
          ...imageKey.split("/"),
        );
        if (
          expiredImagePath.startsWith(
            `${path.resolve(config.submissionsDirectory)}${path.sep}`,
          )
        ) {
          await rm(expiredImagePath, { force: true }).catch(() => undefined);
        }
      }
      return submission;
    },
  );
}

export async function cleanupReviewedCommunitySubmissions(config, now = new Date()) {
  return withCommunitySubmissionIndexLock(
    config.submissionsDirectory,
    async ({ submissions, writeSubmissions }) => {
      const pruned = pruneReviewedCommunitySubmissions(
        submissions,
        now,
        config.retentionDays ?? 30,
      );
      if (pruned.submissions.length !== submissions.length) {
        await writeSubmissions(pruned.submissions);
      }
      for (const imageKey of pruned.removedImageKeys) {
        const expiredImagePath = path.resolve(
          config.submissionsDirectory,
          ...imageKey.split("/"),
        );
        if (
          expiredImagePath.startsWith(
            `${path.resolve(config.submissionsDirectory)}${path.sep}`,
          )
        ) {
          await rm(expiredImagePath, { force: true }).catch(() => undefined);
        }
      }
      return submissions.length - pruned.submissions.length;
    },
  );
}

async function assertDailySubmissionAvailable(config, dailyRateKey) {
  return withCommunitySubmissionIndexLock(
    config.submissionsDirectory,
    async ({ submissions }) => {
      const dailyCount = submissions.filter(
        (item) => item?.dailyRateKey === dailyRateKey,
      ).length;
      if (dailyCount >= maximumDailySubmissions) {
        throw new CommunityRequestError(
          429,
          "本日の投稿上限に達しました。明日もう一度お試しください。",
          "DAILY_RATE_LIMIT",
        );
      }
    },
  );
}

function uploadedFile(form, required) {
  const value = form.get("image");
  if (value === null && !required) return null;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.arrayBuffer !== "function" ||
    typeof value.size !== "number"
  ) {
    throw new CommunityRequestError(
      400,
      required ? "写真を選択してください。" : "画像データが正しくありません。",
      required ? "IMAGE_REQUIRED" : "INVALID_IMAGE",
    );
  }
  return value;
}

export async function acceptCommunitySubmission(form, context) {
  const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  validateBotFields(form, now);

  const kindText = requiredFormText(form, "kind", "投稿の種類", 16);
  let kind;
  let payload;
  try {
    kind = parseCommunitySubmissionKind(kindText);
    const payloadText = requiredFormText(
      form,
      "payload",
      "投稿内容",
      maximumPayloadCharacters,
    );
    let decodedPayload;
    try {
      decodedPayload = JSON.parse(payloadText);
    } catch {
      throw new CommunitySubmissionValidationError(
        "投稿内容のJSONが正しくありません。",
      );
    }
    payload = parseCommunitySubmissionPayload(kind, decodedPayload);
  } catch (error) {
    if (error instanceof CommunitySubmissionValidationError) {
      throw new CommunityRequestError(400, error.message, "INVALID_PAYLOAD");
    }
    throw error;
  }

  const file = uploadedFile(form, kind === "photo");
  let creditName = null;
  if (file) {
    try {
      creditName = parseCommunityCreditName(
        requiredFormText(form, "creditName", "掲載名", 60),
      );
    } catch (error) {
      if (error instanceof CommunitySubmissionValidationError) {
        throw new CommunityRequestError(400, error.message, "INVALID_PAYLOAD");
      }
      throw error;
    }
  }

  const submittedConsentVersion = requiredFormText(
    form,
    "consentVersion",
    "同意内容の版",
    40,
  );
  if (submittedConsentVersion !== context.config.consentVersion) {
    throw new CommunityRequestError(
      409,
      "同意内容が更新されました。画面を再読み込みしてご確認ください。",
      "CONSENT_VERSION_MISMATCH",
    );
  }
  if (requiredFormText(form, "consentAccepted", "投稿条件への同意", 8) !== "true") {
    throw new CommunityRequestError(
      400,
      "投稿条件への同意が必要です。",
      "CONSENT_REQUIRED",
    );
  }

  const dailyRateKey = makeDailyRateKey(
    context.ipAddress,
    now,
    context.config.rateLimitSecret,
  );
  // 大きな画像の再生成や外部認証より先に、明らかな上限超過を止めます。
  // 保存時にも同じ確認を行い、同時投稿による競合を防ぎます。
  await assertDailySubmissionAvailable(context.config, dailyRateKey);

  const localTurnstileBypass = context.config.allowLocalTurnstileBypass &&
    isLocalDevelopmentOrigin(context.origin) &&
    !context.config.turnstileSecret;
  if (!localTurnstileBypass) {
    await verifyTurnstile(
      optionalFormText(form, "turnstileToken", 2_048),
      context.ipAddress,
      context.origin,
      context.config,
      context.fetchImplementation,
      context.recordTurnstileFailure,
    );
  }

  let encodedImage = null;
  let imageHash = null;
  if (file) {
    const originalBytes = Buffer.from(await file.arrayBuffer());
    validateUploadedImage(originalBytes, String(file.type ?? ""));
    encodedImage = await context.imageProcessor(originalBytes);
    imageHash = createHash("sha256").update(encodedImage).digest("hex");
  }

  const id = randomUUID();
  const createdAt = now.toISOString();
  const submission = {
    id,
    kind,
    status: "pending",
    payload,
    imageKey: encodedImage ? `images/${id}.webp` : null,
    imageMime: encodedImage ? "image/webp" : null,
    imageSize: encodedImage?.length ?? null,
    imageSha256: imageHash,
    creditName,
    consentVersion: context.config.consentVersion,
    consentAt: createdAt,
    dailyRateKey,
    createdAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  };

  await persistCommunitySubmission({
    config: context.config,
    submission,
    imageBytes: encodedImage,
  });
  return { id, kind, status: "pending", createdAt };
}

export async function handleCommunityRequest(
  request,
  response,
  options = {},
) {
  const config = options.config ?? loadCommunityServerConfig();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const origin = normalizeOrigin(singleHeader(request, "origin"));

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/api/submissions") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!isAllowedSubmissionOrigin(origin, config)) {
    sendJson(response, 403, { error: "このサイトからは投稿できません。" });
    return;
  }
  if (request.method === "OPTIONS") {
    sendPreflight(response, origin);
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" }, origin);
    return;
  }

  if (activeSubmissionRequests >= maximumConcurrentSubmissions) {
    sendJson(
      response,
      503,
      { error: "投稿受付が混み合っています。少し待ってからお試しください。" },
      origin,
    );
    return;
  }

  activeSubmissionRequests += 1;
  try {
    const form = await parseMultipartForm(request);
    const submission = await acceptCommunitySubmission(form, {
      config,
      origin,
      ipAddress: clientAddress(request),
      now: options.now?.() ?? new Date(),
      fetchImplementation: options.fetchImplementation ?? fetch,
      imageProcessor: options.imageProcessor ?? reencodeCommunityImage,
      recordTurnstileFailure: options.recordTurnstileFailure ??
        ((diagnostic) => appendTurnstileFailureDiagnostic(config, diagnostic)),
    });
    sendJson(response, 201, { submission }, origin);
  } catch (error) {
    const knownError = error instanceof CommunityRequestError;
    const status = knownError ? error.status : 500;
    if (!knownError) {
      console.error("Community submission request failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    sendJson(
      response,
      status,
      {
        error: knownError
          ? error.message
          : "投稿を保存できませんでした。少し待ってから再度お試しください。",
      },
      origin,
    );
  } finally {
    activeSubmissionRequests -= 1;
  }
}

export function createCommunitySubmissionServer(options = {}) {
  const server = createServer((request, response) => {
    void handleCommunityRequest(request, response, options);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 20;
  return server;
}

export async function startCommunitySubmissionServer(options = {}) {
  const config = validateCommunityServerConfig(
    options.config ?? loadCommunityServerConfig(),
  );
  await cleanupReviewedCommunitySubmissions(config);
  const server = createCommunitySubmissionServer({ ...options, config });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const cleanupTimer = setInterval(() => {
    void cleanupReviewedCommunitySubmissions(config).catch((error) => {
      console.error("Community submission cleanup failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }, 6 * 60 * 60 * 1_000);
  cleanupTimer.unref();
  server.once("close", () => clearInterval(cleanupTimer));
  console.log(`Community submission server listening on http://${config.host}:${config.port}`);
  return server;
}

const executedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) {
  startCommunitySubmissionServer().catch((error) => {
    console.error("Community submission server failed to start", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exitCode = 1;
  });
}
