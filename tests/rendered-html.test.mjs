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
  assert.match(html, /一日の巡礼予定を作る/);
  assert.match(html, /期間限定のコラボを巡る/);
  assert.match(html, /おいでよ！石川大観光Ⅱ/);
  assert.match(html, /蓮ノ小四辺形の休日/);
  assert.match(html, /巡礼へ出発する前に/);
  assert.match(html, /内容に同意してサイトを見る/);
  assert.match(html, /ご利用上の注意/);
  assert.match(html, /予定どおりの移動や到着を保証するものではありません/);
  assert.match(html, /金沢駅/);
  assert.match(html, /近江町市場/);
  assert.match(html, /大野からくり記念館/);
  assert.match(html, /カードに描かれた、.*31.*の景色/);
  assert.match(html, /すべてのキャラクター/);
  assert.match(html, /等身パネル：.*百生吟子、安養寺姫芽/);
  assert.match(html, /蓮ノ空歌留多/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("publishes the complete reviewed location lists", async () => {
  const [spots, cardModels, collaborations] = await Promise.all([
    readFile(new URL("../content/spots.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../content/card-models.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../content/collaborations.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(spots.length, 94);
  assert.equal(new Set(spots.map((spot) => spot.id)).size, 94);
  assert.ok(spots.every((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng)));
  assert.equal(
    spots.filter((spot) => spot.activityRecords?.length || spot.sehasEpisodes?.length).length,
    53,
  );
  assert.deepEqual(
    spots.find((spot) => spot.id === "kanazawa-station").activityRecords,
    ["103期 第1話"],
  );
  assert.deepEqual(
    spots.find((spot) => spot.id === "kanazawa-station").sehasEpisodes,
    ["103期 #26"],
  );
  assert.ok(spots.every((spot) => !spot.description.startsWith("登場情報：")));
  assert.equal(spots.find((spot) => spot.id === "higashide-coffee").activityRecords, undefined);
  assert.equal(cardModels.length, 31);
  assert.equal(cardModels.filter((card) => card.spotId).length, 20);
  assert.equal(cardModels.filter((card) => !card.spotId).length, 11);
  assert.ok(cardModels.every((card) => /］.+/.test(card.card)));
  assert.equal(collaborations.length, 2);
  const fifthCollaboration = collaborations.find((item) => item.id === "ishikawa-dai-kanko-2");
  assert.equal(fifthCollaboration.locations.filter((location) => location.members?.length).length, 12);
  assert.ok(
    fifthCollaboration.locations
      .filter((location) => location.members)
      .every((location) => location.role.includes("等身パネル設置")),
  );
  assert.equal(spots.filter((spot) => spot.collaborationIds?.length).length, 21);
  assert.ok(
    collaborations.every((collaboration) =>
      collaboration.locations.every((location) =>
        spots.some((spot) => spot.id === location.spotId),
      ),
    ),
  );
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
  assert.match(map, /routeComputationCache/);
  assert.match(map, /optimizeWaypointOrder/);
});

test("day planner supports multiple stops without a server dependency", async () => {
  const [app, planner, map] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/GooglePilgrimageMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /訪問するスポット/);
  assert.match(app, /推奨順/);
  assert.match(app, /このボタンを押したときだけ検索/);
  assert.match(app, /cardCharacterFilter/);
  assert.match(planner, /東京駅/);
  assert.match(planner, /大阪駅/);
  assert.match(planner, /recommendedStayMinutes/);
  assert.match(map, /requestedRoute\.travelMode === "TRANSIT"/);
});

test("spot photos can be used as readable card backgrounds", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /spotImages\[spot\.id\] \?\? spot\.imageUrl/);
  assert.match(app, /imageUrl \? " has-image"/);
  assert.match(app, /spot\.activityRecords/);
  assert.match(app, /spot\.sehasEpisodes/);
  assert.match(css, /\.spot-card\.has-image/);
  assert.match(css, /\.spot-card__episodes/);
  assert.match(css, /var\(--spot-image\)/);
});

test("local admin writes publishable files before an explicit GitHub push", async () => {
  const [adminApp, localMain, localServer, startScript, pagesMain] =
    await Promise.all([
      readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("../local-admin/main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../server.mjs", import.meta.url), "utf8"),
      readFile(new URL("../start-admin.ps1", import.meta.url), "utf8"),
      readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(adminApp, /exifr/);
  assert.match(adminApp, /makePublicDerivative/);
  assert.match(adminApp, /スポットを編集/);
  assert.match(localMain, /localMode/);
  assert.match(localServer, /127\.0\.0\.1/);
  assert.match(localServer, /writeJsonIfChanged/);
  assert.match(localServer, /writeToken/);
  assert.match(localServer, /"add", "--", "content", "public\/photos"/);
  assert.match(startScript, /build:admin/);
  assert.match(pagesMain, /content\/site\.json/);
  assert.match(pagesMain, /import\.meta\.glob/);
});
