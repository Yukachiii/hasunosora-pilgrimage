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
  assert.match(html, /hero--magazine/);
  assert.match(html, /hero-magazine-number/);
  assert.match(html, /スポットを地図から探す/);
  assert.match(html, /コラボ/);
  assert.match(html, /おいでよ！石川大観光Ⅱ/);
  assert.match(html, /蓮ノ小四辺形の休日/);
  assert.match(html, /利用前の確認/);
  assert.match(html, /内容に同意してサイトを見る/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /visitor-notice__progress[\s\S]{0,200}確認済み[\s\S]{0,100}0[\s\S]{0,100}\/[\s\S]{0,100}3/);
  assert.match(html, /visitor-notice__accept" disabled=/);
  assert.match(html, /ご利用上の注意/);
  assert.match(html, /Ver\. 1\.0\.2/);
  assert.match(html, /予定どおりの移動や到着を保証するものではありません/);
  assert.match(html, /金沢駅/);
  assert.match(html, /近江町市場/);
  assert.match(html, /大野からくり記念館/);
  assert.match(html, /カードモデル地（.*53.*件）/);
  assert.doesNotMatch(html, /判定 [ABC]/);
  assert.match(html, /すべてのキャラクター/);
  assert.match(html, /等身パネル：.*百生吟子、安養寺姫芽/);
  assert.match(html, /蓮ノ空歌留多/);
  assert.match(html, /このサイトの使い方/);
  assert.match(html, /02-choose-method\.png/);
  assert.match(html, /07-card-search\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("illustrated user guide ships every referenced screenshot", async () => {
  const guideImages = [
    "02-choose-method.png",
    "03-add-spots.png",
    "04-plan-stops.png",
    "05-plan-time.png",
    "06-plan-check.png",
    "07-card-search.png",
  ];
  const [app, css] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  await Promise.all(
    guideImages.map((image) => access(new URL(`../public/guide/${image}`, import.meta.url))),
  );
  assert.match(app, /setActiveGuideImage/);
  assert.match(app, /event\.target !== event\.currentTarget\) return/);
  assert.match(app, /event\.key === "Escape"\) setActiveGuideImage\(null\)/);
  assert.match(app, /guide-image-modal/);
  assert.match(app, /className=\{`guide-image-modal\$\{/);
  assert.match(app, /onClick=\{\(event\) => \{\s*if \(event\.target !== event\.currentTarget\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setActiveGuideImage\(null\);/s);
  assert.doesNotMatch(app, /guide-image-modal[\s\S]{0,300}onPointerDown=/);
  assert.match(app, /variant: "card"/);
  assert.match(app, /card-model__image-button/);
  assert.match(app, /guide-image-modal__copyright/);
  assert.match(app, /activeGuideImage\.variant === "card"/);
  assert.doesNotMatch(app, /href="\.\/guide\/[^\"]+" target="_blank"/);
  assert.match(css, /\.guide-image-modal\s*\{/);
  assert.match(css, /\.guide-image-modal--card \.guide-image-modal__dialog\s*\{/);
  assert.match(css, /\.guide-image-modal__copyright\s*\{/);
});

test("publishes the complete reviewed location lists", async () => {
  const [spots, cardModels, collaborations] = await Promise.all([
    readFile(new URL("../content/spots.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../content/card-models.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../content/collaborations.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(spots.length, 97);
  assert.equal(new Set(spots.map((spot) => spot.id)).size, 97);
  assert.ok(spots.every((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng)));
  assert.equal(
    spots.filter((spot) => (
      spot.activityRecords?.length || spot.sehasEpisodes?.length || spot.withMeetsEpisodes?.length
    )).length,
    54,
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
  assert.deepEqual(
    spots.find((spot) => spot.id === "higashide-coffee").withMeetsEpisodes,
    ["103期 2023/7/24『蓮ノ空1年生の会！』（村野さやか紹介・16:01頃）"],
  );
  assert.equal(
    spots.find((spot) => spot.id === "higashide-coffee").sourceUrl,
    "https://www.youtube.com/watch?v=T2mjEvzjnMQ&t=961s",
  );
  assert.equal(cardModels.length, 53);
  const cardCharacterNames = [
    "日野下花帆", "村野さやか", "乙宗梢", "夕霧綴理", "大沢瑠璃乃", "藤島慈",
    "百生吟子", "徒町小鈴", "安養寺姫芽", "セラス 柳田 リリエンフェルト", "桂城泉",
  ];
  assert.ok(cardModels.every((card) => (
    cardCharacterNames.filter((character) => card.card.includes(character)).length === 1
  )));
  assert.equal(cardModels.filter((card) => card.imageUrl).length, 53);
  assert.ok(cardModels.some((card) => card.card.includes("［宇宙演舞☆うさぴょん］")));
  assert.equal(cardModels.find((card) => card.id === "card-10").imageUrl, "./card-images/model-cards/seras-yanagida-lilienfeld.jpg");
  assert.equal(cardModels.find((card) => card.id === "card-11").imageUrl, "./card-images/model-cards/katsuragi-izumi.jpg");
  assert.equal(cardModels.find((card) => card.id === "card-06").imageUrl, "./card-images/model-cards/fujishima-megumi.jpg");
  await Promise.all(
    cardModels
      .filter((card) => card.imageUrl)
      .map((card) => access(new URL(`../public/${card.imageUrl.replace(/^\.\//, "")}`, import.meta.url))),
  );
  assert.equal(cardModels.filter((card) => card.spotId).length, 44);
  assert.equal(cardModels.filter((card) => !card.spotId).length, 9);
  assert.equal(cardModels.find((card) => card.id === "card-13").spotId, "kingyoan");
  assert.equal(
    cardModels.find((card) => card.id === "card-14").spotId,
    "koko-hotel-kanazawa-korinbo",
  );
  assert.equal(cardModels.find((card) => card.id === "card-21").spotId, "mameda-ground");
  assert.equal(
    spots.find((spot) => spot.id === "koko-hotel-kanazawa-korinbo").name,
    "KOKO HOTEL Premier 金沢香林坊",
  );
  assert.ok(
    ["card-24", "card-25", "card-26", "card-27", "card-28", "card-29", "card-30", "card-31"].every(
      (cardId) => cardModels.find((card) => card.id === cardId).spotId === null,
    ),
  );
  assert.ok(cardModels.every((card) => /］.+/.test(card.card)));
  assert.ok(cardModels.every((card) => !/重複|第1部 No\./.test(card.note)));
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
  assert.equal(JSON.parse(packageJson).version, "1.0.2");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});

test("GitHub Pages ships public release metadata", async () => {
  const [index, robots, sitemap, manifestRaw] = await Promise.all([
    readFile(new URL("../github-pages/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../public/site.webmanifest", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);

  assert.match(index, /rel="canonical" href="https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/"/);
  assert.match(index, /property="og:image"/);
  assert.match(index, /name="twitter:card" content="summary_large_image"/);
  assert.match(index, /%BASE_URL%favicon\.svg/);
  assert.match(index, /%BASE_URL%site\.webmanifest/);
  assert.match(robots, /Sitemap: https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/<\/loc>/);
  assert.equal(manifest.start_url, "/hasunosora-pilgrimage/");
  assert.equal(manifest.short_name, "蓮ノ旅");
  await access(new URL("../public/favicon.svg", import.meta.url));
});

test("Mapbox map and route integration stays guarded", async () => {
  const [page, map, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(map, /mapbox:\/\/styles\/mapbox\/standard/);
  assert.match(map, /language: "ja"/);
  assert.match(map, /theme: "faded"/);
  assert.match(map, /optimized-trips\/v1/);
  assert.match(map, /directions\/v5/);
  assert.match(map, /optimizeWaypointOrder/);
  assert.match(map, /serverResponse\.status === 404 \|\| serverResponse\.status >= 500/);
  assert.match(map, /"planned", GREEN_MARKER_IMAGE_ID/);
  assert.match(map, /"card", BLUE_MARKER_IMAGE_ID/);
  assert.match(map, /"collaboration", YELLOW_MARKER_IMAGE_ID/);
  assert.match(map, /\["zoom"\][\s\S]+\["length", \["get", "indexLabel"\]\]/);
  assert.match(css, /@media \(min-width: 1081px\)[\s\S]+\.selected-map-detail__heading strong \{[\s\S]+font-size: 24px;/);
  assert.match(css, /@media \(min-width: 1081px\)[\s\S]+\.selected-map-detail__card-grid \{[\s\S]+grid-template-columns: minmax\(0, 1fr\);/);
  await Promise.all(["red", "yellow", "blue", "green"].map((color) =>
    access(new URL(`../public/map-markers/${color}.png`, import.meta.url)),
  ));
});

test("day planner supports multiple stops without a server dependency", async () => {
  const [app, planner, map, yahooTransit, css] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/yahoo-transit.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /訪問するスポット/);
  assert.match(app, /itinerary-editor__empty/);
  assert.match(css, /\.itinerary-editor li\.itinerary-editor__empty\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(app, /訪問順を自動で最適化/);
  assert.match(app, /const \[optimizeOrder, setOptimizeOrder\] = useState\(false\)/);
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
  assert.match(app, /className="journey-start__today"/);
  assert.match(app, /setVisitDate\(japanDate\(\)\)/);
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
  assert.match(routeApi, /Google Mapsとの通信に失敗しました/);
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

  assert.match(app, /fillItineraryFromCollaboration/);
  assert.match(app, /このコラボで予定を作る/);
  assert.doesNotMatch(app, /コラボから訪問スポットを自動入力/);
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
  assert.match(adminApp, /カードモデル地の確認/);
  assert.match(adminApp, /信頼度は管理用です/);
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

  assert.match(storage, /PLANNER_DRAFT_COOKIE_KEY/);
  assert.match(storage, /serializePlannerDraftCookie/);
  assert.match(storage, /parsePlannerDraftCookie/);
  assert.match(app, /document\.cookie/);
  assert.doesNotMatch(app, /localStorage\.setItem\(PLANNER_DRAFT/);
  assert.match(storage, /transitLegProgress/);
  assert.match(storage, /sanitizeTransitLegProgress/);
  assert.match(storage, /plannerDays/);
  assert.match(storage, /PlannerDaySnapshot/);
  assert.match(storage, /activeDayIndex/);
  assert.match(storage, /v:\s*3/);
  assert.match(storage, /optimizeOrder: candidate\.optimizeOrder === true/);
  assert.match(app, /sanitizePlannerSnapshot/);
  assert.match(app, /この内容は計算済みです/);
  assert.match(app, /当日の予定/);
  assert.match(app, /日程を追加/);
  assert.match(app, /plannerDays\.length > 1/);
  assert.match(app, /複数日にする/);
  assert.match(app, /className="planner-extras"/);
  assert.match(app, /宿泊地（任意）/);
  assert.match(app, /時間を固定する予定/);
  assert.match(app, /終了目安/);
  assert.doesNotMatch(app, /APIは使用しません/);
  assert.match(app, /現在地からGoogle Mapsで向かう/);
  assert.doesNotMatch(app, /LOCAL SAVE/);
  assert.doesNotMatch(app, /旅程をこの端末に保存/);
  assert.match(app, /スマートフォン用メニュー/);
  assert.match(app, /mobile-explore-picker/);
  assert.match(app, /スポット・カード一覧/);
  assert.match(app, /isExplorePickerOpen/);
  assert.match(app, /aria-expanded=\{isExplorePickerOpen\}/);
  assert.match(app, /aria-pressed=\{isExplorePickerOpen \|\| Boolean\(activeExplorePanel\)\}/);
  assert.match(app, /function navigateToPage\([\s\S]*?setIsExplorePickerOpen\(false\);/);
  assert.match(app, /<span>ホーム<\/span>/);
  assert.match(app, /navigateToPage\("explore", "spots"\)/);
  assert.match(app, /navigateToPage\("explore", "card-models"\)/);
  assert.match(app, /const closeExplorePanel = useCallback/);
  assert.match(app, /setIsExploreSheetClosing\(true\)/);
  assert.match(app, /window\.setTimeout\([\s\S]*?180\)/);
  assert.match(app, /aria-pressed=\{activeExplorePanel === "spots"\}/);
  assert.match(app, /aria-pressed=\{activeExplorePanel === "card-models"\}/);
  assert.match(app, /mobile-nav--sheet-open/);
  assert.match(app, /isEditingItineraryOrder/);
  assert.match(app, /順序を変更/);
  assert.match(app, /className="transit-search-panel"/);
  assert.match(app, /className="today-mode__tools"/);
  assert.doesNotMatch(app, /className="selection-tray"/);
  assert.doesNotMatch(app, /同意画面をもう一度確認する/);
  assert.match(app, /className="hero-magazine-rule"/);
  assert.match(app, /端末内の保存と外部サービス/);
  assert.match(app, /運営者のサーバーには保存されず/);
  assert.match(app, /非公式ファンサイト/);
  assert.doesNotMatch(app, /非公式の試作サイト/);
  assert.match(app, /mapReturnSection/);
  assert.match(app, /スポット一覧へ戻る/);
  assert.match(app, /カードモデル地へ戻る/);
  assert.match(app, /activeExplorePanel/);
  assert.match(app, /className=\{`explore-sheet\$\{isExploreSheetClosing/);
  assert.match(app, /aria-label="一覧を切り替える"/);
  assert.match(app, /spotSourceFilter/);
  assert.match(app, /With×MEETS/);
  assert.match(app, /className="explore-sheet__grab-zone"/);
  assert.match(app, /event\.clientY - startY >= 72/);
  assert.match(app, /aria-label="閉じる"/);
  assert.match(app, /aria-controls="spot-advanced-filters"/);
  assert.match(app, /className=\{`spot-filters__advanced/);
  assert.match(app, /className="card-model__topline"[\s\S]*?<h3>\{card\.card\}<\/h3>/);
  assert.doesNotMatch(app, /この枠内を上下にスクロール/);
  assert.match(css, /\.map-return-link/);
  assert.match(css, /\.explore-sheet__panel/);
  assert.match(css, /\.explore-sheet :is\(\.spot-grid, \.card-model-grid\)\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
  assert.match(css, /\.explore-sheet__body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.explore-sheet \.spot-filters__advanced\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.explore-sheet \.spot-filters__advanced\.is-expanded\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.card-model__image figcaption\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*6px/s);
  assert.match(css, /\.explore-sheet \.card-model-filter > p\s*\{[^}]*display:\s*none/s);
  assert.match(app, /href=\{`#\/\$\{page\}`\}/);
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
  assert.match(css, /\.mobile-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(css, /\.mobile-explore-picker\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows:\s*repeat\(2,/s);
  assert.match(css, /animation:\s*mobile-explore-picker-grow/);
  assert.match(css, /\.explore-sheet\.is-closing \.explore-sheet__panel/);
  assert.match(css, /@keyframes explore-sheet-exit/);
  assert.match(css, /@keyframes explore-sheet-content-enter/);
  assert.match(css, /button\[aria-current="page"\]/);
  assert.match(css, /\.transit-search-panel__confirmed/);
  assert.match(css, /\.transit-search-panel__progress/);
  assert.match(css, /\.map-layout\s*\{[^}]*align-items:\s*stretch/s);
  assert.match(css, /\.route-planner\s*\{[^}]*align-self:\s*stretch[^}]*height:\s*auto[^}]*max-height:\s*none/s);
  assert.match(css, /\.route-workspace__controls/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.journey-start__datetime\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.selected-spot-bar strong\s*\{[^}]*white-space:\s*normal/s);
  assert.doesNotMatch(css, /scroll-snap-(?:type|align)/);
  assert.match(css, /\.route-planner \.itinerary-editor > ol\s*\{[^}]*max-height:\s*none/s);
  assert.match(css, /@media \(max-width:\s*1080px\)[\s\S]*?\.route-planner\s*\{[^}]*max-height:\s*none/s);
  const rightColumn = app.match(/<aside className="route-planner"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(rightColumn, /訪問するスポット/);
  assert.doesNotMatch(rightColumn, /journey-start|travel-modes|collaboration-route-fill/);
  assert.match(app, /className="route-workspace" id="planner"/);
  assert.match(app, /予定の経路/);
  assert.match(app, /activePage === "planner" \? itinerarySpots : spots/);
  assert.match(app, /activePage === "planner" && plannerStep === 3/);
  assert.match(css, /\.app-page--planner \.map-column--route \.map-shell\s*\{[^}]*height:\s*480px/s);
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
  assert.match(map, /showCompass:\s*true/);
  assert.match(map, /map\.resize\(\)/);
  assert.match(map, /routeLinesRef/);
  assert.doesNotMatch(map, /cluster:\s*true/);
  assert.doesNotMatch(map, /SPOT_CLUSTER/);
  assert.doesNotMatch(map, /getClusterExpansionZoom/);
  assert.match(page, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(pagesEntry, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.doesNotMatch(pagesConfig, /github-pages\/mapbox\/index\.html/);
  assert.match(envExample, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(workflow, /MAPBOX_ACCESS_TOKEN/);
  assert.match(app, /MapboxPilgrimageMap/);
  assert.match(app, /id="map-freeword-search"/);
  assert.match(app, /この場所に関連するカード/);
  assert.doesNotMatch(app, /Mapbox比較版|href="\.\/mapbox\//);
  await assert.rejects(access(new URL("../app/mapbox/page.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../github-pages/mapbox/index.html", import.meta.url)));
});
