import assert from "node:assert/strict";
import { File } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommunitySubmissionValidationError,
  parseCommunitySubmissionPayload,
} from "../app/community-submissions.ts";
import {
  acceptCommunitySubmission,
  createCommunitySubmissionServer,
  makeDailyRateKey,
  pruneReviewedCommunitySubmissions,
  reencodeCommunityImage,
  validateCommunityServerConfig,
  validateUploadedImage,
} from "../community-server.mjs";

test("community photo payload accepts only a valid spot and plain-text comment", () => {
  assert.deepEqual(
    parseCommunitySubmissionPayload("photo", {
      spotId: "kanazawa-station",
      comment: "  鼓門を正面から撮影しました。  ",
    }),
    {
      spotId: "kanazawa-station",
      comment: "鼓門を正面から撮影しました。",
    },
  );
  assert.throws(
    () => parseCommunitySubmissionPayload("photo", {
      spotId: "kanazawa-station",
      comment: "<img src=x onerror=alert(1)>",
    }),
    CommunitySubmissionValidationError,
  );
  assert.throws(
    () => parseCommunitySubmissionPayload("photo", {
      spotId: "kanazawa-station",
      admin: true,
    }),
    CommunitySubmissionValidationError,
  );
});

test("community spot payload requires only name, address and evidence URL", () => {
  assert.deepEqual(
    parseCommunitySubmissionPayload("spot", {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "https://example.com/source",
    }),
    {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "https://example.com/source",
    },
  );
  assert.throws(
    () => parseCommunitySubmissionPayload("spot", {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "javascript:alert(1)",
    }),
    /httpまたはhttps/,
  );
  assert.throws(
    () => parseCommunitySubmissionPayload("spot", {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "https://example.com/source",
      lat: 36.5,
    }),
    /緯度と経度を両方/,
  );
  for (const sourceUrl of [
    "http://127.0.0.1:8765/api/admin/state",
    "http://192.168.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://device.local/",
  ]) {
    assert.throws(
      () => parseCommunitySubmissionPayload("spot", {
        name: "候補地",
        address: "石川県金沢市",
        sourceUrl,
      }),
      /ローカルネットワーク/,
    );
  }
  assert.equal(
    parseCommunitySubmissionPayload("spot", {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "https://fc.example.com/source",
    }).sourceUrl,
    "https://fc.example.com/source",
  );
});

test("daily rate keys rotate by date and do not contain the raw address", () => {
  const first = makeDailyRateKey(
    "203.0.113.10",
    new Date("2026-09-04T00:00:00.000Z"),
    "test-secret",
  );
  const second = makeDailyRateKey(
    "203.0.113.10",
    new Date("2026-09-05T00:00:00.000Z"),
    "test-secret",
  );
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes("203.0.113.10"), false);
});

test("public receiver startup requires an origin, rate secret, and Turnstile secret", () => {
  const validConfig = {
    allowedOrigins: new Set(["https://guide.example.test"]),
    rateLimitSecret: "r".repeat(32),
    turnstileSecret: "turnstile-secret",
    allowLocalTurnstileBypass: false,
  };
  assert.equal(validateCommunityServerConfig(validConfig), validConfig);
  assert.throws(
    () => validateCommunityServerConfig({ ...validConfig, allowedOrigins: new Set() }),
    /COMMUNITY_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () => validateCommunityServerConfig({ ...validConfig, rateLimitSecret: "short" }),
    /24 characters/,
  );
  assert.throws(
    () => validateCommunityServerConfig({ ...validConfig, turnstileSecret: "" }),
    /TURNSTILE_SECRET_KEY/,
  );
  const localConfig = {
    ...validConfig,
    allowedOrigins: new Set(["http://127.0.0.1:3000"]),
    turnstileSecret: "",
    allowLocalTurnstileBypass: true,
  };
  assert.equal(validateCommunityServerConfig(localConfig), localConfig);
});

test("reviewed submissions expire while pending submissions remain private", () => {
  const oldDate = "2026-07-01T00:00:00.000Z";
  const recentDate = "2026-09-01T00:00:00.000Z";
  const result = pruneReviewedCommunitySubmissions(
    [
      { id: "pending-old", status: "pending", reviewedAt: null, imageKey: "images/pending.webp" },
      { id: "rejected-old", status: "rejected", reviewedAt: oldDate, imageKey: "images/rejected.webp" },
      { id: "imported-recent", status: "imported", reviewedAt: recentDate, imageKey: "images/imported.webp" },
    ],
    new Date("2026-09-04T00:00:00.000Z"),
    30,
  );
  assert.deepEqual(result.submissions.map((submission) => submission.id), [
    "pending-old",
    "imported-recent",
  ]);
  assert.deepEqual(result.removedImageKeys, ["images/rejected.webp"]);
});

test("image validation checks size, signature and declared MIME", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  assert.equal(validateUploadedImage(jpeg, "image/jpeg"), "image/jpeg");
  assert.throws(
    () => validateUploadedImage(jpeg, "image/png"),
    /形式が正しくありません/,
  );
  assert.throws(
    () => validateUploadedImage(Buffer.from("not an image"), "image/jpeg"),
    /JPEG、PNG、WebP/,
  );
});

test("community images are resized, normalized to WebP, and stripped of metadata", async () => {
  const { default: sharp } = await import("sharp");
  const original = await sharp({
    create: {
      width: 3_000,
      height: 1_000,
      channels: 3,
      background: { r: 120, g: 180, b: 220 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const encoded = await reencodeCommunityImage(original);
  const metadata = await sharp(encoded).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok((metadata.width ?? Infinity) <= 2_560);
  assert.ok((metadata.height ?? Infinity) <= 2_560);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

function submissionForm({
  kind,
  payload,
  image = null,
  creditName = "投稿者",
  turnstileToken = "",
}) {
  const form = new FormData();
  form.set("kind", kind);
  form.set("payload", JSON.stringify(payload));
  form.set("startedAt", String(Date.parse("2026-09-04T11:59:50.000Z")));
  form.set("website", "");
  form.set("turnstileToken", turnstileToken);
  form.set("consentVersion", "2026-09-04");
  form.set("consentAccepted", "true");
  if (creditName !== null) form.set("creditName", creditName);
  if (image) form.set("image", image);
  return form;
}

test("accepted entries are private pending records and enforce five per day", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "community-submissions-"));
  let imageProcessingCount = 0;
  const config = {
    allowedOrigins: new Set(),
    submissionsDirectory: temporaryDirectory,
    turnstileSecret: "",
    rateLimitSecret: "test-rate-secret",
    consentVersion: "2026-09-04",
    allowLocalTurnstileBypass: true,
  };
  const context = {
    config,
    origin: "http://127.0.0.1:3000",
    ipAddress: "203.0.113.20",
    now: new Date("2026-09-04T12:00:00.000Z"),
    fetchImplementation: fetch,
    imageProcessor: async () => {
      imageProcessingCount += 1;
      return Buffer.from("private webp derivative");
    },
  };

  try {
    for (let index = 0; index < 5; index += 1) {
      const result = await acceptCommunitySubmission(
        submissionForm({
          kind: "photo",
          payload: { spotId: "kanazawa-station", comment: `写真${index + 1}` },
          image: new File(
            [Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
            `secret-${index}.jpg`,
            { type: "image/jpeg" },
          ),
        }),
        context,
      );
      assert.deepEqual(Object.keys(result).sort(), ["createdAt", "id", "kind", "status"]);
      assert.equal(result.status, "pending");
    }

    await assert.rejects(
      acceptCommunitySubmission(
        submissionForm({
          kind: "photo",
          payload: { spotId: "kanazawa-station" },
          image: new File(
            [Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
            "sixth-secret.jpg",
            { type: "image/jpeg" },
          ),
        }),
        context,
      ),
      (error) => error?.code === "DAILY_RATE_LIMIT" && error?.status === 429,
    );
    assert.equal(imageProcessingCount, 5, "the sixth image must be rejected before processing");

    const index = JSON.parse(
      await readFile(path.join(temporaryDirectory, "index.json"), "utf8"),
    );
    assert.equal(index.length, 5);
    assert.equal(index[0].status, "pending");
    assert.equal(index[0].imageMime, "image/webp");
    assert.match(index[0].imageKey, /^images\/[a-f0-9-]+\.webp$/);
    assert.equal(JSON.stringify(index).includes("203.0.113.20"), false);
    assert.equal(JSON.stringify(index).includes("secret-0.jpg"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("spot suggestions without an image do not require or retain a credit name", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "community-spots-"));
  try {
    const result = await acceptCommunitySubmission(
      submissionForm({
        kind: "spot",
        payload: {
          name: "候補地",
          address: "石川県金沢市",
          sourceUrl: "https://example.com/source",
        },
        creditName: null,
      }),
      {
        config: {
          allowedOrigins: new Set(),
          submissionsDirectory: temporaryDirectory,
          turnstileSecret: "",
          rateLimitSecret: "test-rate-secret",
          consentVersion: "2026-09-04",
          allowLocalTurnstileBypass: true,
        },
        origin: "http://localhost:3000",
        ipAddress: "203.0.113.30",
        now: new Date("2026-09-04T12:00:00.000Z"),
        fetchImplementation: fetch,
        imageProcessor: async () => {
          throw new Error("must not process an absent image");
        },
      },
    );
    assert.equal(result.kind, "spot");
    const [saved] = JSON.parse(
      await readFile(path.join(temporaryDirectory, "index.json"), "utf8"),
    );
    assert.equal(saved.creditName, null);
    assert.equal(saved.imageKey, null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Turnstile verification must match the contribution action and origin hostname", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "community-turnstile-"));
  const origin = "https://guide.example.test";
  const config = {
    allowedOrigins: new Set([origin]),
    submissionsDirectory: temporaryDirectory,
    turnstileSecret: "turnstile-secret",
    rateLimitSecret: "test-rate-secret",
    consentVersion: "2026-09-04",
    allowLocalTurnstileBypass: false,
  };
  const makeForm = () => submissionForm({
    kind: "spot",
    payload: {
      name: "候補地",
      address: "石川県金沢市",
      sourceUrl: "https://example.com/source",
    },
    creditName: null,
    turnstileToken: "verified-token",
  });
  const context = (verificationResult) => ({
    config,
    origin,
    ipAddress: "203.0.113.40",
    now: new Date("2026-09-04T12:00:00.000Z"),
    fetchImplementation: async () => new Response(
      JSON.stringify(verificationResult),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    imageProcessor: async () => {
      throw new Error("must not process an absent image");
    },
  });

  try {
    await assert.rejects(
      acceptCommunitySubmission(makeForm(), context({
        success: true,
        action: "different_action",
        hostname: "guide.example.test",
      })),
      (error) => error?.code === "TURNSTILE_FAILED",
    );
    await assert.rejects(
      acceptCommunitySubmission(makeForm(), context({
        success: true,
        action: "community_submission",
        hostname: "attacker.example",
      })),
      (error) => error?.code === "TURNSTILE_FAILED",
    );
    const accepted = await acceptCommunitySubmission(makeForm(), context({
      success: true,
      action: "community_submission",
      hostname: "guide.example.test",
    }));
    assert.equal(accepted.status, "pending");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("submission HTTP endpoint applies exact CORS and returns no private fields", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "community-http-"));
  const allowedOrigin = "https://guide.example.test";
  const server = createCommunitySubmissionServer({
    config: {
      allowedOrigins: new Set([allowedOrigin]),
      submissionsDirectory: temporaryDirectory,
      turnstileSecret: "",
      rateLimitSecret: "test-rate-secret",
      consentVersion: "2026-09-04",
      allowLocalTurnstileBypass: true,
    },
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    imageProcessor: async () => Buffer.from("unused"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const rejected = await fetch(`${baseUrl}/api/submissions`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);

    const form = submissionForm({
      kind: "spot",
      payload: {
        name: "候補地",
        address: "石川県金沢市",
        sourceUrl: "https://example.com/source",
      },
      creditName: null,
    });
    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { origin: allowedOrigin },
      body: form,
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.deepEqual(await response.json(), {
      error: "投稿受付の認証設定が完了していません。",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
