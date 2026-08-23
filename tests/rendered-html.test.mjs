import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function requestApp(request) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    request,
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

async function render() {
  return requestApp(new Request("http://localhost/", {
    headers: {
      accept: "text/html",
      host: "localhost",
    },
  }));
}

test("server-renders the pilgrimage MVP", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /蓮ノ旅/);
  assert.doesNotMatch(html, /好きな物語と|同じ景色/);
  assert.match(html, /hero-title-space/);
  assert.match(html, /一日の巡礼予定を作る/);
  assert.match(html, /期間限定のコラボを巡る/);
  assert.match(html, /おいでよ！石川大観光Ⅱ/);
  assert.match(html, /蓮ノ小四辺形の休日/);
  assert.match(html, /巡礼へ出発する前に/);
  assert.match(html, /内容に同意してサイトを見る/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /visitor-notice__progress[\s\S]{0,200}確認済み[\s\S]{0,100}0[\s\S]{0,100}\/[\s\S]{0,100}3/);
  assert.match(html, /visitor-notice__accept" disabled=/);
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

test("Mapbox map and route integration stays guarded", async () => {
  const [page, map] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(map, /mapbox:\/\/styles\/mapbox\/standard/);
  assert.match(map, /language: "ja"/);
  assert.match(map, /theme: "faded"/);
  assert.match(map, /optimized-trips\/v1/);
  assert.match(map, /directions\/v5/);
  assert.match(map, /optimizeWaypointOrder/);
});

test("day planner supports multiple stops without a server dependency", async () => {
  const [app, planner, map, yahooTransit] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/yahoo-transit.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /訪問するスポット/);
  assert.match(app, /訪問順を自動で最適化/);
  assert.match(app, /移動時間と訪問順を計算し、一日の予定として表示します/);
  assert.match(app, /cardCharacterFilter/);
  assert.match(planner, /東京駅/);
  assert.match(planner, /大阪駅/);
  assert.match(planner, /recommendedStayMinutes/);
  assert.match(map, /requestedRoute\.travelMode === "TRANSIT"/);
  assert.doesNotMatch(map, /公共交通機関と主要駅からの経路検索は現在準備中/);
  assert.match(app, /Yahoo!乗換案内で検索/);
  assert.match(app, /Yahoo!の検索結果を確認する/);
  assert.match(app, /confirmedTransitLegCount/);
  assert.match(app, /全国の主要駅から最初のスポット/);
  assert.doesNotMatch(app, /公共交通（準備中）/);
  assert.match(yahooTransit, /transit\.yahoo\.co\.jp\/search\/result/);
  assert.match(yahooTransit, /m1: paddedMinute\[0\]/);
  assert.match(yahooTransit, /m2: paddedMinute\[1\]/);
});

test("server route planner validates requests before using Google Routes", async () => {
  const response = await requestApp(new Request("http://localhost/api/routes/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stopIds: ["kanazawa-station"],
      travelMode: "WALKING",
      optimizeWaypointOrder: true,
      stayMinutes: { "kanazawa-station": 15 },
      departureTime: new Date().toISOString(),
    }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /2～27か所/);

  const [routeApi, map, page, pagesMain, workflow, usageStore] = await Promise.all([
    readFile(new URL("../app/api/routes/plan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../db/route-usage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(routeApi, /GOOGLE_ROUTES_SERVER_API_KEY/);
  assert.match(routeApi, /routes\.googleapis\.com\/directions\/v2:computeRoutes/);
  assert.match(routeApi, /requestsPerWindow = 10/);
  assert.match(routeApi, /inFlightPlans/);
  assert.match(routeApi, /departureTime: cursor\.toISOString\(\)/);
  assert.match(routeApi, /maximumItineraryStops/);
  assert.match(routeApi, /recordRouteApiUsage/);
  assert.match(usageStore, /INSERT INTO route_api_usage/);
  assert.doesNotMatch(usageStore, /connecting-ip|x-forwarded-for|spotIds|sourceStationId/);
  assert.match(map, /source: "server"/);
  assert.match(page, /routeServiceUrl="\/api\/routes\/plan"/);
  assert.match(pagesMain, /VITE_ROUTE_API_URL/);
  assert.match(workflow, /ROUTE_API_URL/);
});

test("collaboration locations can fill a route plan without an API request", async () => {
  const [app, planner, collaborations] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../content/collaborations.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(app, /コラボから自動入力/);
  assert.match(app, /fillItineraryFromCollaboration/);
  assert.match(app, /このコラボで予定を作る/);
  assert.match(app, /対象地点をまとめて予定へ追加します/);
  assert.doesNotMatch(app, /料金区分|API不使用|Google API|サーバー計算|ブラウザ計算/);
  assert.match(planner, /maximumItineraryStops = 27/);
  assert.equal(
    collaborations.find((item) => item.id === "ishikawa-dai-kanko-2").locations.length,
    13,
  );
  assert.equal(
    collaborations.find((item) => item.id === "kaga-onsen-2026").locations.length,
    9,
  );
});

test("the 13-location Ishikawa collaboration fits in one non-transit route request", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GOOGLE_ROUTES_SERVER_API_KEY;
  const collaborations = JSON.parse(
    await readFile(new URL("../content/collaborations.json", import.meta.url), "utf8"),
  );
  const collaboration = collaborations.find((item) => item.id === "ishikawa-dai-kanko-2");
  const stopIds = collaboration.locations.map((location) => location.spotId);
  const googleRequests = [];
  process.env.GOOGLE_ROUTES_SERVER_API_KEY = "test-only";
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://routes.googleapis.com/")) {
      return originalFetch(input, init);
    }
    googleRequests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      routes: [{
        distanceMeters: 125000,
        duration: "14400s",
        legs: Array.from({ length: stopIds.length - 1 }, () => ({ duration: "1200s" })),
        optimizedIntermediateWaypointIndex: Array.from(
          { length: stopIds.length - 2 },
          (_, index) => index,
        ),
        polyline: { encodedPolyline: "_p~iF~ps|U" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const response = await requestApp(new Request("http://localhost/api/routes/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stopIds,
        travelMode: "DRIVING",
        optimizeWaypointOrder: true,
        stayMinutes: Object.fromEntries(stopIds.map((id) => [id, 30])),
        departureTime: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.orderedStopIds.length, 13);
    assert.equal(result.apiRequestCount, 1);
    assert.equal(googleRequests.length, 1);
    assert.equal(googleRequests[0].intermediates.length, 11);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_ROUTES_SERVER_API_KEY;
    else process.env.GOOGLE_ROUTES_SERVER_API_KEY = originalKey;
  }
});

test("Routes API usage is private and available in the admin dashboard", async () => {
  const response = await requestApp(new Request("http://localhost/api/admin/route-usage"));
  assert.equal(response.status, 403);

  const [adminApp, adminApi, schema, migration, localServer] = await Promise.all([
    readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/route-usage/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_bored_firelord.sql", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(adminApp, /API使用状況/);
  assert.match(adminApp, /Google Cloud側の請求確定値/);
  assert.match(adminApp, /直近14日間のAPIリクエスト数/);
  assert.match(adminApi, /hasRouteUsageAdminToken/);
  assert.match(schema, /routeApiUsage/);
  assert.match(migration, /CREATE TABLE `route_api_usage`/);
  assert.match(migration, /route_api_usage_month_mode_idx/);
  assert.match(localServer, /ROUTE_USAGE_ADMIN_TOKEN/);
  assert.match(localServer, /"x-route-usage-admin-token": token/);
});

test("server route planner sends public transit to Yahoo without using Google Routes", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GOOGLE_ROUTES_SERVER_API_KEY;
  const googleRequests = [];
  const departure = new Date(Date.now() + 86_400_000);
  departure.setUTCSeconds(0, 0);
  process.env.GOOGLE_ROUTES_SERVER_API_KEY = "test-only";
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://routes.googleapis.com/")) {
      return originalFetch(input, init);
    }
    googleRequests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      routes: [{
        distanceMeters: 1000,
        duration: "600s",
        legs: [{ duration: "600s" }],
        polyline: { encodedPolyline: "_p~iF~ps|U" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const response = await requestApp(new Request("http://localhost/api/routes/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stopIds: ["kanazawa-station", "ohmicho-market", "kanazawa-katani"],
        travelMode: "TRANSIT",
        optimizeWaypointOrder: false,
        stayMinutes: {
          "kanazawa-station": 15,
          "ohmicho-market": 30,
          "kanazawa-katani": 35,
        },
        sourceStationId: "tokyo",
        departureTime: departure.toISOString(),
      }),
    }));
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, "EXTERNAL_TRANSIT");
    assert.match(result.error, /Yahoo!乗換案内/);
    assert.equal(googleRequests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_ROUTES_SERVER_API_KEY;
    else process.env.GOOGLE_ROUTES_SERVER_API_KEY = originalKey;
  }
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
  assert.match(localServer, /isPrivateIpv4/);
  assert.match(localServer, /lanAdminUrl/);
  assert.match(localMain, /localNetworkUrl/);
  assert.match(adminApp, /スマホから管理画面を開く/);
  assert.match(localServer, /writeJsonIfChanged/);
  assert.match(localServer, /writeToken/);
  assert.match(localServer, /"add", "--", "content", "public\/photos"/);
  assert.match(startScript, /build:admin/);
  assert.match(startScript, /\$BindHost = "0\.0\.0\.0"/);
  assert.match(pagesMain, /content\/site\.json/);
  assert.match(pagesMain, /import\.meta\.glob/);
});

test("planner persistence, opening hours, and today mode avoid extra route requests", async () => {
  const [app, storage, routePlanner, adminApp, schema, migration, css] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/planner-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_lucky_the_hood.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(storage, /PLANNER_DRAFT_STORAGE_KEY/);
  assert.match(storage, /SAVED_ITINERARIES_STORAGE_KEY/);
  assert.match(storage, /transitLegProgress/);
  assert.match(storage, /sanitizeTransitLegProgress/);
  assert.match(app, /前回の編集中旅程を復元しました/);
  assert.match(app, /この内容は計算済みです/);
  assert.match(app, /当日用モード/);
  assert.match(app, /現在地からGoogle Mapsで向かう/);
  assert.match(app, /この端末に保存/);
  assert.match(app, /スマートフォン用メニュー/);
  assert.match(app, /href="#planner"/);
  assert.match(routePlanner, /openingHoursStatus/);
  assert.match(routePlanner, /営業時間は公式情報を確認/);
  assert.match(adminApp, /通常の休業曜日/);
  assert.match(adminApp, /営業時間の確認日/);
  assert.match(schema, /openingHoursCheckedAt/);
  assert.match(migration, /opening_hours_checked_at/);
  assert.match(css, /\.today-mode__dialog/);
  assert.match(css, /\.spot-card__hours/);
  assert.match(css, /Public page: touch-first layout/);
  assert.match(css, /\.mobile-nav/);
  assert.match(css, /\.transit-search-panel__confirmed/);
  assert.match(css, /\.transit-search-panel__progress/);
  assert.match(css, /\.route-planner\s*\{[^}]*max-height:\s*660px/s);
  assert.match(css, /@media \(max-width:\s*1080px\)[\s\S]*?\.route-planner\s*\{[^}]*max-height:\s*none/s);
});

test("Mapbox is the main map and the comparison version is removed", async () => {
  const [map, page, pagesEntry, pagesConfig, envExample, app, workflow] = await Promise.all([
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
  ]);

  assert.match(map, /optimized-trips\/v1/);
  assert.match(map, /directions\/v5/);
  assert.match(map, /showTransitLabels: true/);
  assert.match(page, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(pagesEntry, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.doesNotMatch(pagesConfig, /github-pages\/mapbox\/index\.html/);
  assert.match(envExample, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(workflow, /MAPBOX_ACCESS_TOKEN/);
  assert.match(app, /MAP BY MAPBOX/);
  assert.doesNotMatch(app, /Mapbox比較版|href="\.\/mapbox\//);
  await assert.rejects(access(new URL("../app/mapbox/page.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../github-pages/mapbox/index.html", import.meta.url)));
});
