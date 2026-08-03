import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        host: "localhost",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the pilgrimage MVP", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /蓮ノ旅/);
  assert.match(html, /好きな物語と/);
  assert.match(html, /巡礼ルートを検索/);
  assert.match(html, /金沢駅/);
  assert.match(html, /近江町市場/);
  assert.match(html, /大野からくり記念館/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("starter preview is fully replaced", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /PilgrimageApp/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});

test("Google Maps and Routes integration stays guarded", async () => {
  const [page, map] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/GooglePilgrimageMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /GOOGLE_MAPS_BROWSER_API_KEY/);
  assert.match(page, /GOOGLE_MAPS_MAP_ID/);
  assert.match(map, /maps\.googleapis\.com\/maps\/api\/js/);
  assert.match(map, /auth_referrer_policy=origin/);
  assert.match(map, /gm_authFailure/);
  assert.match(map, /importLibrary\("routes"\)/);
  assert.match(map, /computeRoutes/);
});

test("spot photos can be used as readable card backgrounds", async () => {
  const [spots, app, css, photo] = await Promise.all([
    readFile(new URL("../app/spots.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../public/photos/kanazawa-station/20260724-230203-watermarked.webp",
        import.meta.url,
      ),
    ),
  ]);

  assert.match(
    spots,
    /photos\/kanazawa-station\/20260724-230203-watermarked\.webp/,
  );
  assert.match(app, /spotImages\[spot\.id\] \?\? spot\.imageUrl/);
  assert.match(app, /imageUrl \? " has-image"/);
  assert.match(css, /\.spot-card\.has-image/);
  assert.match(css, /var\(--spot-image\)/);
  assert.equal(photo.includes(Buffer.from("Exif\0\0")), false);
});

test("admin MVP protects edits and stores photos outside the source tree", async () => {
  const [adminPage, adminApp, auth, schema, hosting, uploadRoute] =
    await Promise.all([
      readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("../lib/admin-auth.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/admin/media/route.ts", import.meta.url),
        "utf8",
      ),
    ]);

  assert.match(adminPage, /requireAdminPage\("\/admin"\)/);
  assert.match(auth, /ADMIN_EMAIL/);
  assert.match(adminApp, /exifr/);
  assert.match(adminApp, /makePublicDerivative/);
  assert.match(adminApp, /スポットを編集/);
  assert.match(schema, /media_assets/);
  assert.match(schema, /spot_overrides/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "MEDIA"/);
  assert.match(uploadRoute, /getMediaBucket/);
});
