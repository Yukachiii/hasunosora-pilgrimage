import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function freeLoopbackPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.equal(typeof address, "object");
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

function waitForReady(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Admin server did not start.\n${output}\n${errors}`));
    }, timeoutMs);
    const onOutput = (chunk) => {
      output += chunk.toString();
      if (output.includes("Hasunosora Admin (PC):")) {
        cleanup();
        resolve();
      }
    };
    const onErrorOutput = (chunk) => {
      errors += chunk.toString();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Admin server exited before startup (${code}).\n${output}\n${errors}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrorOutput);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrorOutput);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Admin server did not stop."));
    }, timeoutMs);
    const onExit = (code) => {
      cleanup();
      resolve(code);
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
    }
    child.once("exit", onExit);
  });
}

function pendingSubmission({ id, kind, payload, imageBytes = null }) {
  return {
    id,
    kind,
    status: "pending",
    payload,
    imageKey: imageBytes ? `images/${id}.webp` : null,
    imageMime: imageBytes ? "image/webp" : null,
    imageSize: imageBytes?.length ?? null,
    imageSha256: imageBytes
      ? createHash("sha256").update(imageBytes).digest("hex")
      : null,
    creditName: imageBytes ? "テスト投稿者" : null,
    consentVersion: "2026-09-04",
    consentAt: "2026-09-04T12:00:00.000Z",
    dailyRateKey: `test-${id}`,
    createdAt: "2026-09-04T12:00:00.000Z",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  };
}

function tokyoDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

test("local admin imports reviewed photos and spots, and rejects without publishing", {
  timeout: 30_000,
}, async () => {
  const testDirectory = await mkdtemp(
    path.join(projectDirectory, ".community-admin-test-"),
  );
  const submissionsDirectory = path.join(testDirectory, "private", "community-submissions");
  const contentDirectory = path.join(testDirectory, "content");
  const adminDirectory = path.join(testDirectory, "admin-dist");
  const photoSubmissionId = "11111111-1111-4111-8111-111111111111";
  const anonymousPhotoSubmissionId = "44444444-4444-4444-8444-444444444444";
  const spotSubmissionId = "22222222-2222-4222-8222-222222222222";
  const rejectedSubmissionId = "33333333-3333-4333-8333-333333333333";
  let child = null;
  let writeToken = "";
  let baseUrl = "";

  try {
    await copyFile(
      path.join(projectDirectory, "server.mjs"),
      path.join(testDirectory, "server.mjs"),
    );
    await mkdir(adminDirectory, { recursive: true });
    await writeFile(path.join(adminDirectory, "index.html"), "<!doctype html><title>QA</title>", "utf8");
    await mkdir(path.join(testDirectory, "public", "photos"), { recursive: true });
    await mkdir(path.join(submissionsDirectory, "images"), { recursive: true });

    const { default: sharp } = await import("sharp");
    const submittedImage = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 120, g: 180, b: 220 },
      },
    }).webp().toBuffer();
    await writeFile(
      path.join(submissionsDirectory, "images", `${photoSubmissionId}.webp`),
      submittedImage,
    );
    await writeFile(
      path.join(submissionsDirectory, "images", `${anonymousPhotoSubmissionId}.webp`),
      submittedImage,
    );

    const initialSpot = {
      id: "existing-spot",
      name: "既存スポット",
      shortName: "既存スポット",
      area: "金沢駅周辺",
      category: "文化",
      address: "石川県金沢市",
      lat: 36.578,
      lng: 136.648,
      description: "テスト用の既存スポットです。",
      accessNote: "徒歩",
      sourceUrl: "https://example.com/existing",
    };
    await writeJson(path.join(contentDirectory, "spots.json"), [initialSpot]);
    await writeJson(path.join(contentDirectory, "media.json"), []);
    await writeJson(path.join(contentDirectory, "site.json"), {
      version: "4.0.0",
      heroImage: null,
      heroImages: [],
    });
    await writeJson(path.join(contentDirectory, "transit-search-names.json"), {
      "existing-spot": "既存スポット",
    });
    await writeJson(path.join(submissionsDirectory, "index.json"), [
      pendingSubmission({
        id: photoSubmissionId,
        kind: "photo",
        payload: { spotId: "existing-spot", comment: "正面から撮影" },
        imageBytes: submittedImage,
      }),
      {
        ...pendingSubmission({
          id: anonymousPhotoSubmissionId,
          kind: "photo",
          payload: { spotId: "existing-spot", comment: "掲載名なし" },
          imageBytes: submittedImage,
        }),
        creditName: null,
      },
      pendingSubmission({
        id: spotSubmissionId,
        kind: "spot",
        payload: {
          name: "新規候補地",
          address: "石川県金沢市広坂",
          sourceUrl: "https://example.com/candidate",
        },
      }),
      pendingSubmission({
        id: rejectedSubmissionId,
        kind: "spot",
        payload: {
          name: "却下候補",
          address: "石川県金沢市",
          sourceUrl: "https://example.com/reject",
        },
      }),
    ]);
    await writeJson(path.join(submissionsDirectory, "diagnostics", "api-usage.json"), {
      schemaVersion: 1,
      trackingStartedAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:05:00.000Z",
      timeZone: "Asia/Tokyo",
      allTime: {
        submissionRequests: 12,
        submissionAccepted: 8,
        submissionRejected: { turnstile: 2, validation: 1, system: 1 },
        turnstileApiRequests: 11,
        turnstileVerified: 8,
        turnstileFailed: 3,
        turnstileRetries: 1,
      },
      daily: [{
        date: tokyoDateKey(),
        submissionRequests: 3,
        submissionAccepted: 2,
        submissionRejected: { turnstile: 1, validation: 0, system: 0 },
        turnstileApiRequests: 4,
        turnstileVerified: 2,
        turnstileFailed: 2,
        turnstileRetries: 1,
      }],
    });

    const port = await freeLoopbackPort();
    const unusedCommunityPort = await freeLoopbackPort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(testDirectory, "server.mjs"), "--port", String(port)], {
      cwd: testDirectory,
      env: {
        ...process.env,
        COMMUNITY_SUBMISSIONS_DIRECTORY: submissionsDirectory,
        COMMUNITY_SERVER_PORT: String(unusedCommunityPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForReady(child);

    const identityResponse = await fetch(`${baseUrl}/api/admin/identity`, {
      cache: "no-store",
    });
    assert.equal(identityResponse.status, 200);
    assert.equal(identityResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await identityResponse.json(), {
      application: "hasunosora-pilgrimage-admin",
      schemaVersion: 1,
    });

    const stateResponse = await fetch(`${baseUrl}/api/admin/state`, { cache: "no-store" });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    writeToken = state.writeToken;
    assert.equal(typeof writeToken, "string");
    assert.equal(state.submissions.length, 4);

    const usageResponse = await fetch(`${baseUrl}/api/admin/community-usage`, {
      cache: "no-store",
    });
    assert.equal(usageResponse.status, 200);
    assert.equal(usageResponse.headers.get("cache-control"), "no-store");
    const usage = await usageResponse.json();
    assert.equal(usage.available, true);
    assert.equal(usage.timeZone, "Asia/Tokyo");
    assert.equal(usage.trackingStartedAt, "2026-09-06T00:00:00.000Z");
    assert.deepEqual(usage.today, {
      submissionAttempts: 3,
      submissionsAccepted: 2,
      submissionsFailed: 1,
      turnstileRequests: 4,
      turnstileSuccessful: 2,
      turnstileFailed: 2,
      turnstileRetries: 1,
    });
    assert.deepEqual(usage.currentMonth, usage.today);
    assert.deepEqual(usage.allTime, {
      submissionAttempts: 12,
      submissionsAccepted: 8,
      submissionsFailed: 4,
      turnstileRequests: 11,
      turnstileSuccessful: 8,
      turnstileFailed: 3,
      turnstileRetries: 1,
    });
    assert.deepEqual(usage.retained, { pending: 4, accepted: 0, rejected: 0 });
    assert.equal(usage.receiver.status, "unreachable");

    const headers = {
      "content-type": "application/json",
      "x-local-admin-token": writeToken,
    };
    const photoResponse = await fetch(
      `${baseUrl}/api/admin/submissions/${photoSubmissionId}/import`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          spotId: "existing-spot",
          reviewNote: "写真を確認済み",
        }),
      },
    );
    assert.equal(photoResponse.status, 200);
    const photoResult = await photoResponse.json();
    assert.equal(photoResult.submission.status, "imported");
    assert.equal(photoResult.asset.submissionId, photoSubmissionId);
    assert.equal(photoResult.asset.creditName, "テスト投稿者");

    const anonymousPhotoResponse = await fetch(
      `${baseUrl}/api/admin/submissions/${anonymousPhotoSubmissionId}/import`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          spotId: "existing-spot",
          reviewNote: "匿名写真を確認済み",
        }),
      },
    );
    assert.equal(anonymousPhotoResponse.status, 200);
    const anonymousPhotoResult = await anonymousPhotoResponse.json();
    assert.equal(anonymousPhotoResult.submission.status, "imported");
    assert.equal(anonymousPhotoResult.asset.submissionId, anonymousPhotoSubmissionId);
    assert.equal(anonymousPhotoResult.asset.creditName, "匿名");

    const spotResponse = await fetch(
      `${baseUrl}/api/admin/submissions/${spotSubmissionId}/import`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          reviewNote: "根拠と位置を確認済み",
          spot: {
            id: "new-community-spot",
            name: "新規候補地",
            shortName: "新規候補地",
            area: "金沢駅周辺",
            category: "文化",
            address: "石川県金沢市広坂",
            lat: 36.561,
            lng: 136.656,
            description: "審査済みの新しいスポットです。",
            accessNote: "訪問前に最新情報を確認",
            sourceUrl: "https://example.com/candidate",
            transitSearchName: "新規候補地 石川県金沢市広坂",
            recommendedStayMinutes: 30,
          },
        }),
      },
    );
    assert.equal(spotResponse.status, 200);
    const spotResult = await spotResponse.json();
    assert.equal(spotResult.submission.status, "imported");
    assert.equal(spotResult.spot.id, "new-community-spot");

    const rejectResponse = await fetch(
      `${baseUrl}/api/admin/submissions/${rejectedSubmissionId}/reject`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewNote: "根拠不足" }),
      },
    );
    assert.equal(rejectResponse.status, 200);
    assert.equal((await rejectResponse.json()).submission.status, "rejected");

    const spots = JSON.parse(await readFile(path.join(contentDirectory, "spots.json"), "utf8"));
    const media = JSON.parse(await readFile(path.join(contentDirectory, "media.json"), "utf8"));
    const transitNames = JSON.parse(
      await readFile(path.join(contentDirectory, "transit-search-names.json"), "utf8"),
    );
    const queue = JSON.parse(
      await readFile(path.join(submissionsDirectory, "index.json"), "utf8"),
    );
    assert.deepEqual(spots.map((spot) => spot.id), ["existing-spot", "new-community-spot"]);
    assert.equal(media.length, 2);
    const attributedAsset = media.find((asset) => asset.submissionId === photoSubmissionId);
    const anonymousAsset = media.find((asset) => asset.submissionId === anonymousPhotoSubmissionId);
    assert.ok(attributedAsset);
    assert.ok(anonymousAsset);
    assert.equal(attributedAsset.creditName, "テスト投稿者");
    assert.equal(anonymousAsset.creditName, "匿名");
    assert.equal(spots[0].imageUrl, attributedAsset.imageUrl);
    assert.equal(transitNames["new-community-spot"], "新規候補地 石川県金沢市広坂");
    assert.deepEqual(
      queue.map((submission) => submission.status),
      ["imported", "imported", "imported", "rejected"],
    );
    assert.equal(
      await readFile(
        path.join(testDirectory, "public", ...anonymousAsset.imageUrl.split("/").filter(Boolean)),
      ).then((bytes) => bytes.length > 0),
      true,
    );
  } finally {
    if (child && child.exitCode === null) {
      if (writeToken && baseUrl) {
        const exiting = waitForExit(child).catch(() => null);
        await fetch(`${baseUrl}/api/admin/shutdown`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-admin-token": writeToken,
          },
          body: "{}",
        }).catch(() => undefined);
        await exiting;
      } else {
        child.kill();
        await waitForExit(child).catch(() => null);
      }
    }
    await rm(testDirectory, { recursive: true, force: true });
  }
});
