import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  if (!address || typeof address === "string") {
    throw new Error("Loopback test port was not assigned.");
  }
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForReady(child, baseUrl, timeoutMs = 10_000) {
  let errors = "";
  const onErrorOutput = (chunk) => {
    errors += chunk.toString();
  };
  child.stderr.on("data", onErrorOutput);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Admin server exited before startup (${child.exitCode}).\n${errors}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/admin/identity`, {
          cache: "no-store",
          signal: AbortSignal.timeout(500),
        });
        const identity = await response.json().catch(() => null);
        if (response.ok && identity?.application) return identity;
      } catch {
        // The listener may not be ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Admin server did not start.\n${errors}`);
  } finally {
    child.stderr.off("data", onErrorOutput);
  }
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

function fixtureGit(directory, gitArguments) {
  const result = spawnSync("git", ["-C", directory, ...gitArguments], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function pendingSubmission({ id, kind, payload, imageBytes = null }) {
  return {
    id,
    kind,
    status: "pending",
    payload,
    imageKey: imageBytes ? `images/${id}.webp` : null,
    imageSha256: imageBytes
      ? createHash("sha256").update(imageBytes).digest("hex")
      : null,
    creditName: imageBytes ? "テスト投稿者" : null,
    createdAt: "2026-09-04T12:00:00.000Z",
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

function anotherTokyoDateThisMonth(now = new Date()) {
  const today = tokyoDateKey(now);
  return `${today.slice(0, 8)}${today.endsWith("-01") ? "02" : "01"}`;
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
      }, {
        date: anotherTokyoDateThisMonth(),
        submissionRequests: 5,
        submissionAccepted: 4,
        submissionRejected: { turnstile: 0, validation: 1, system: 0 },
        turnstileApiRequests: 5,
        turnstileVerified: 4,
        turnstileFailed: 1,
        turnstileRetries: 0,
      }],
    });

    const port = await freeLoopbackPort();
    const unusedCommunityPort = await freeLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(testDirectory, "server.mjs"), "--port", String(port)], {
      cwd: testDirectory,
      env: {
        ...process.env,
        COMMUNITY_SUBMISSIONS_DIRECTORY: submissionsDirectory,
        COMMUNITY_SERVER_PORT: String(unusedCommunityPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    assert.deepEqual(await waitForReady(child, baseUrl), {
      application: "hasunosora-pilgrimage-admin",
      schemaVersion: 1,
    });

    const stateResponse = await fetch(`${baseUrl}/api/admin/state`, { cache: "no-store" });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.headers.get("cache-control"), "no-store");
    const state = await stateResponse.json();
    const writeToken = state.writeToken;
    assert.equal(typeof writeToken, "string");
    assert.equal(state.submissions.length, 4);

    const usageResponse = await fetch(`${baseUrl}/api/admin/community-usage`, {
      cache: "no-store",
    });
    assert.equal(usageResponse.status, 200);
    const usage = await usageResponse.json();
    assert.deepEqual(usage.today, {
      submissionAttempts: 3,
      submissionsAccepted: 2,
      submissionsFailed: 1,
      turnstileRequests: 4,
      turnstileSuccessful: 2,
      turnstileFailed: 2,
      turnstileRetries: 1,
    });
    assert.deepEqual(usage.currentMonth, {
      submissionAttempts: 8,
      submissionsAccepted: 6,
      submissionsFailed: 2,
      turnstileRequests: 9,
      turnstileSuccessful: 6,
      turnstileFailed: 3,
      turnstileRetries: 1,
    });
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
      child.kill();
      await waitForExit(child).catch(() => null);
    }
    await rm(testDirectory, { recursive: true, force: true });
  }
});

test("publishing rejects unrelated staged changes without modifying the index, then publishes only public changes", {
  timeout: 30_000,
}, async () => {
  const testDirectory = await mkdtemp(
    path.join(projectDirectory, ".community-admin-publish-test-"),
  );
  const repositoryDirectory = path.join(testDirectory, "repository");
  const remoteDirectory = path.join(testDirectory, "remote.git");
  let child = null;

  try {
    await mkdir(repositoryDirectory);
    await copyFile(
      path.join(projectDirectory, "server.mjs"),
      path.join(repositoryDirectory, "server.mjs"),
    );
    await mkdir(path.join(repositoryDirectory, "admin-dist"));
    await writeFile(
      path.join(repositoryDirectory, "admin-dist", "index.html"),
      "<!doctype html><title>Publish QA</title>",
      "utf8",
    );
    await mkdir(path.join(repositoryDirectory, "public", "photos"), { recursive: true });
    await writeJson(path.join(repositoryDirectory, "content", "spots.json"), []);
    await writeJson(path.join(repositoryDirectory, "content", "media.json"), []);
    await writeFile(path.join(repositoryDirectory, "developer-notes.txt"), "Original notes\n", "utf8");
    fixtureGit(testDirectory, ["init", "--bare", remoteDirectory]);
    fixtureGit(repositoryDirectory, ["init", "--initial-branch=main"]);
    fixtureGit(repositoryDirectory, ["config", "user.name", "Publish QA"]);
    fixtureGit(repositoryDirectory, ["config", "user.email", "publish-qa@example.invalid"]);
    fixtureGit(repositoryDirectory, ["config", "core.hooksPath", "NUL"]);
    fixtureGit(repositoryDirectory, ["config", "commit.gpgsign", "false"]);
    fixtureGit(repositoryDirectory, ["add", "--", "content", "developer-notes.txt"]);
    fixtureGit(repositoryDirectory, ["commit", "-m", "Initial fixture"]);
    fixtureGit(repositoryDirectory, ["remote", "add", "origin", remoteDirectory]);
    fixtureGit(repositoryDirectory, ["push", "--set-upstream", "origin", "main"]);

    await writeJson(path.join(repositoryDirectory, "content", "spots.json"), [{ id: "public-change" }]);
    await writeFile(path.join(repositoryDirectory, "public", "photos", "candidate.webp"), "Public photo\n", "utf8");
    await writeFile(path.join(repositoryDirectory, "developer-notes.txt"), "Private development notes\n", "utf8");
    fixtureGit(repositoryDirectory, ["add", "--", "developer-notes.txt"]);
    const initialHead = fixtureGit(repositoryDirectory, ["rev-parse", "HEAD"]);
    const initialIndex = fixtureGit(repositoryDirectory, ["diff", "--cached", "--binary"]);
    const initialUnstaged = fixtureGit(repositoryDirectory, ["diff", "--binary"]);

    const port = await freeLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(repositoryDirectory, "server.mjs"), "--port", String(port)], {
      cwd: repositoryDirectory,
      env: {
        ...process.env,
        COMMUNITY_SUBMISSIONS_DIRECTORY: path.join(repositoryDirectory, "private", "community-submissions"),
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    await waitForReady(child, baseUrl);
    const statusResponse = await fetch(`${baseUrl}/api/admin/publish-status`);
    assert.equal(statusResponse.status, 200);
    const { publishToken } = await statusResponse.json();
    const publish = () => fetch(`${baseUrl}/api/admin/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishToken }),
    });

    const refusedResponse = await publish();
    assert.equal(refusedResponse.status, 400);
    assert.match((await refusedResponse.json()).error, /公開対象外.*ステージ/);
    assert.equal(fixtureGit(repositoryDirectory, ["rev-parse", "HEAD"]), initialHead);
    assert.equal(fixtureGit(remoteDirectory, ["rev-parse", "refs/heads/main"]), initialHead);
    assert.equal(fixtureGit(repositoryDirectory, ["diff", "--cached", "--binary"]), initialIndex);
    assert.equal(fixtureGit(repositoryDirectory, ["diff", "--binary"]), initialUnstaged);

    fixtureGit(repositoryDirectory, ["reset", "--", "developer-notes.txt"]);
    fixtureGit(repositoryDirectory, ["add", "--", "public/photos/candidate.webp"]);
    const publishedResponse = await publish();
    assert.equal(publishedResponse.status, 200);
    assert.deepEqual(await publishedResponse.json(), {
      committed: true,
      pushed: true,
      revision: fixtureGit(repositoryDirectory, ["rev-parse", "--short", "HEAD"]).trim(),
    });
    assert.deepEqual(
      fixtureGit(repositoryDirectory, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split(/\r?\n/),
      ["content/spots.json", "public/photos/candidate.webp"],
    );
    assert.equal(fixtureGit(remoteDirectory, ["rev-parse", "refs/heads/main"]), fixtureGit(repositoryDirectory, ["rev-parse", "HEAD"]));
    assert.equal(fixtureGit(repositoryDirectory, ["show", "HEAD:developer-notes.txt"]), "Original notes\n");
    assert.equal(await readFile(path.join(repositoryDirectory, "developer-notes.txt"), "utf8"), "Private development notes\n");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child).catch(() => null);
    }
    await rm(testDirectory, { recursive: true, force: true });
  }
});
