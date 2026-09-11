import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { reorderIdsForInsertion, sameIdOrder } from "../app/itinerary-order.ts";

test("itinerary order helper moves an id to each insertion point", () => {
  const original = ["station", "market", "park", "museum"];
  assert.deepEqual(
    reorderIdsForInsertion(original, "station", 2),
    ["market", "park", "station", "museum"],
  );
  assert.deepEqual(
    reorderIdsForInsertion(original, "museum", 0),
    ["museum", "station", "market", "park"],
  );
  assert.deepEqual(
    reorderIdsForInsertion(original, "market", 99),
    ["station", "park", "museum", "market"],
  );
  assert.deepEqual(reorderIdsForInsertion(original, "missing", 0), original);
  assert.equal(sameIdOrder(reorderIdsForInsertion(original, "market", 1), original), true);
  assert.equal(sameIdOrder(reorderIdsForInsertion(original, "market", 3), original), false);
});

test("public entry renders the pilgrimage application", async () => {
  const [entry, app, html, site, packageJson] = await Promise.all([
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/index.html", import.meta.url), "utf8"),
    readFile(new URL("../content/site.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(entry, /createRoot/);
  assert.match(entry, /<PilgrimageApp/);
  assert.match(entry, /class PublicAppErrorBoundary/);
  assert.match(entry, /<PublicAppErrorBoundary>/);
  assert.match(entry, /画面の表示を続けられませんでした/);
  assert.match(entry, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.match(app, /蓮ノ旅/);
  assert.match(app, /hero--magazine/);
  assert.match(app, /写真や新しいスポットを送る/);
  assert.match(app, /href="#\/explore\/community-contribution"/);
  assert.match(html, /lang="ja"/);
  assert.match(html, /og\.png/);
  assert.equal(site.version, "3.0.3");
  assert.equal(packageJson.version, site.version);
  assert.doesNotMatch(entry + app + html, /codex-preview|Your site is taking shape/i);
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
  assert.match(app, /alt: card\.card,\s*variant: "card"/);
  assert.doesNotMatch(app, /alt: `\$\{card\.card\}のカードイラスト`,\s*variant: "card"/);
  assert.match(app, /card-model__image-button/);
  assert.match(app, /guide-image-modal__copyright/);
  assert.match(app, /activeGuideImage\.variant === "card"/);
  assert.match(app, /©︎PL!HS ©︎S ©︎2023 BNML ©︎ODD No\./);
  assert.equal((app.match(/\{CARD_ILLUSTRATION_COPYRIGHT\}/g) ?? []).length, 2);
  assert.doesNotMatch(app, /<figcaption>\s*<a[\s\S]*?CARD_ILLUSTRATION_COPYRIGHT/);
  assert.doesNotMatch(app, /guide-image-modal__copyright">\s*<a/);
  assert.doesNotMatch(app, /href="\.\/guide\/[^\"]+" target="_blank"/);
  assert.match(css, /\.guide-image-modal\s*\{/);
  assert.match(css, /\.guide-image-modal--card \.guide-image-modal__dialog\s*\{/);
  assert.match(css, /\.guide-image-modal__copyright\s*\{/);
});

test("standalone guide redesign test stays isolated from the public application", async () => {
  const [html, entry, page, css] = await Promise.all([
    readFile(new URL("../github-pages/guide-test/index.html", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/guide-test/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/guide-test/GuideTestPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/guide-test/guide-test.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /noindex, nofollow/);
  assert.match(entry, /GuideTestPage/);
  assert.doesNotMatch(entry, /globals\.css/);
  assert.match(page, /旅の準備は/);
  assert.match(page, /parsePlannerDraftCookie/);
  assert.equal((page.match(/src: `\$\{baseUrl\}guide\//g) ?? []).length, 6);
  assert.match(page, /role="dialog"/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /event\.target === event\.currentTarget/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /!important/);
});

test("full UI redesign trial mirrors the public features while keeping test state isolated", async () => {
  const [html, entry, app, planner, css, viteConfig] = await Promise.all([
    readFile(new URL("../github-pages/ui-test/index.html", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/ui-test/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/ui-test/UiTrialApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/ui-test/use-live-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/ui-test/ui-test.css", import.meta.url), "utf8"),
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /noindex, nofollow/);
  assert.match(entry, /UiTrialApp/);
  assert.match(entry, /import\.meta\.glob/);
  assert.match(entry, /spotPhotoGroups/);
  assert.match(entry, /photoCredits/);
  assert.match(entry, /chooseHeroIndex/);
  assert.match(entry, /ui-test-hero-image\.v1/);
  assert.match(entry, /TrialAppErrorBoundary/);
  assert.doesNotMatch(entry, /globals\.css/);
  assert.match(viteConfig, /uiTest: resolve\("github-pages\/ui-test\/index\.html"\)/);
  for (const page of ["ExplorePage", "PlannerPage", "TodayPage", "GuidePage"]) {
    assert.match(app, new RegExp(`function ${page}\\(`));
  }
  assert.match(app, /MapboxPilgrimageMap/);
  assert.match(app, /onPointerMove/);
  assert.match(app, /移動時間を計算する/);
  assert.match(app, /訪問済みにする/);
  assert.match(app, /SharedPreviewPage/);
  assert.match(app, /#蓮ノ旅/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /selectedCollaborationId/);
  assert.match(app, /ui-trial__feature-context/);
  assert.match(app, /ui-trial__feature-brand/);
  assert.doesNotMatch(app, /金沢の風景/);
  assert.match(app, /ui-trial__explore-window-filters/);
  assert.match(app, /modalFilterCount > 0/);
  assert.match(app, /modalFiltersExpanded/);
  assert.match(app, /aria-controls="ui-trial-modal-filters"/);
  assert.match(app, /ui-trial__search-filters/);
  assert.match(app, /translateY\(calc\(100% \+ 24px\)\)/);
  assert.match(app, /function ExploreModeTabs/);
  assert.equal((app.match(/<ExploreModeTabs/g) ?? []).length, 1);
  assert.match(app, /exploreChoices\.filter\(\(choice\) => choice\.mode !== "map"\)/);
  assert.match(app, /openExploreModal !== "collaboration" \? <div className="ui-trial__explore-window-filters">/);
  assert.doesNotMatch(app, /sourceFilter, setSourceFilter/);
  assert.match(app, /ExploreSourceFilter/);
  assert.match(app, /useLayoutEffect/);
  const pointerMove = app.match(/function movePointerDrag[\s\S]*?function moveWithKeyboard/)?.[0] ?? "";
  assert.match(pointerMove, /setPreviewOrder/);
  assert.match(pointerMove, /const fromIndex = drag\.currentIndex/);
  assert.match(pointerMove, /next\.splice\(fromIndex, 1\)/);
  assert.doesNotMatch(pointerMove, /onReorder/);
  assert.match(app, /if \(commit && drag\.startIndex !== drag\.currentIndex\)[\s\S]*?onReorder\(drag\.startIndex, drag\.currentIndex\)/);
  assert.match(app, /onReorderStateChange\(true\)/);
  assert.match(app, /isReordering \|\|[\s\S]*?planner\.routeResult\.state === "loading"/);
  assert.match(app, /if \(nextIsReordering\) cancelRouteCalculation\(\)/);
  assert.match(app, /label: "地図"[\s\S]*label: "スポット"[\s\S]*label: "カード"[\s\S]*label: "コラボ"/);
  assert.match(app, /id="ui-trial-main-map"/);
  assert.match(app, /className="ui-trial__home-map"/);
  assert.doesNotMatch(app, /baseUrl\}#\/explore\/map/);
  assert.match(app, /setExploreMapView\(nextPage === "explore" && parts\[1\] === "map"\)/);
  assert.match(app, /mapView=\{exploreMapView\}/);
  assert.match(app, /className="ui-trial__page ui-trial__map-page"/);
  assert.match(app, /className="ui-trial__modal ui-trial__explore-window"/);
  assert.match(app, /aria-labelledby="ui-trial-explore-window-title"/);
  assert.match(app, /openMode\(choice\.mode\)/);
  assert.match(app, /openExploreModal === "cards"/);
  assert.match(app, /openExploreModal === "collaboration"/);
  assert.doesNotMatch(app, /className="ui-trial__explorer"/);
  assert.match(app, /spotQuery, setSpotQuery/);
  assert.match(app, /spotAreaFilter, setSpotAreaFilter/);
  assert.match(app, /spotSourceFilter, setSpotSourceFilter/);
  assert.match(app, /cardCharacterFilter, setCardCharacterFilter/);
  assert.match(app, /kind: "card" as const/);
  assert.match(app, /ui-trial__map-related-cards/);
  assert.match(app, /ui-trial__spot-photo-strip/);
  assert.match(app, /return source \? displayAssetUrl\(source\) : undefined/);
  assert.match(app, /className="ui-trial__spot-result-photo is-empty"/);
  assert.doesNotMatch(app, /spotPhoto\(spot, spotPhotoGroups, fallbackPhoto\)/);
  assert.match(app, /kind: "spot-map"/);
  assert.match(app, /地図で開く/);
  assert.match(app, /CARD_ILLUSTRATION_COPYRIGHT/);
  assert.match(app, /CommunityContributionPanel/);
  assert.match(app, /submissionPath="\/api\/ui-test-submissions"/);
  assert.match(app, /共有しない情報/);
  assert.match(app, /宿泊地・自由予定・訪問済みの進捗・出発駅/);
  assert.match(app, /planner\.addDay/);
  assert.match(app, /planner\.removeActiveDay/);
  assert.match(app, /planner\.addAppointment/);
  assert.match(app, /planner\.transitLegs/);
  assert.match(app, /planner\.resetTodayOffset/);
  assert.match(app, /planner\.resetCompleted/);
  assert.match(app, /exploreSheetExpanded/);
  assert.match(app, /function moveExploreSheetDrag/);
  const exploreSheetDrag = app.match(/function beginExploreSheetDrag[\s\S]*?function moveExploreSheetDrag/)?.[0] ?? "";
  const exploreSheetMove = app.match(/function moveExploreSheetDrag[\s\S]*?function finishExploreSheetDrag/)?.[0] ?? "";
  const exploreSheetFinish = app.match(/function finishExploreSheetDrag[\s\S]*?function openMode/)?.[0] ?? "";
  const exploreSheetClose = exploreSheetFinish.match(/if \(drag\.dragged && deltaY >= closeDistance\) \{[\s\S]*?return;\s*\}/)?.[0] ?? "";
  const genericModalDrag = app.match(/function beginDrag[\s\S]*?function moveDrag/)?.[0] ?? "";
  assert.match(exploreSheetDrag, /setPointerCapture\(event\.pointerId\)/);
  assert.match(exploreSheetMove, /downwardY - collapseTravel/);
  assert.match(exploreSheetFinish, /const closeDistance = collapseTravel \+ 90/);
  assert.doesNotMatch(exploreSheetClose, /removeProperty\("height"\)/);
  assert.match(genericModalDrag, /setPointerCapture\(event\.pointerId\)/);
  const todayPage = app.match(/function TodayPage[\s\S]*?function SharedPreviewPage/)?.[0] ?? "";
  assert.doesNotMatch(todayPage, /<img/);
  assert.doesNotMatch(app, /実働テスト|本番データ非干渉/);
  assert.match(planner, /hasunosora-pilgrimage\.ui-test-planner\.v1/);
  assert.match(planner, /hasunosora-pilgrimage\.ui-test-route-cache\.v1/);
  assert.match(planner, /createSharedPlanSnapshot/);
  assert.match(planner, /sanitizePlannerSnapshot/);
  assert.match(planner, /cancelRouteCalculation: invalidateRoute/);
  assert.match(planner, /createYahooTransitLegs/);
  assert.match(planner, /const addDay = useCallback/);
  assert.match(planner, /const addAppointment = useCallback/);
  assert.match(planner, /const resetTodayOffset = useCallback/);
  assert.match(planner, /const \[dayRouteCache, setDayRouteCache\]/);
  assert.match(planner, /const cachedRoute = dayRouteCache\[plannerDays\[index\]\.id\]/);
  assert.doesNotMatch(app, />探す画面を開く</);
  assert.doesNotMatch(planner, /PLANNER_DRAFT_COOKIE_KEY/);
  assert.doesNotMatch(planner, /document\.cookie/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /ui-trial__route-map[\s\S]*?height: clamp/);
  assert.match(css, /ui-trial__explore-window-filters/);
  assert.match(css, /\.ui-trial__explore-window-filters > \.ui-trial__search-filters:not\(\.is-expanded\)/);
  assert.match(css, /\.ui-trial__filter-toggle/);
  assert.match(css, /\.ui-trial__feature-brand/);
  assert.match(css, /\.ui-trial__modal-dialog\.is-closing/);
  assert.match(css, /\.ui-trial__map-page-map/);
  assert.match(css, /\.ui-trial__explore-mode-tabs/);
  assert.match(css, /\.ui-trial__home-map/);
  assert.match(css, /\.ui-trial__modal-dialog\.is-dragging/);
  assert.match(css, /\.ui-trial__map-page-detail \{[\s\S]*?margin: 12px 0 0/);
  assert.match(css, /\.ui-trial__explore-window-dialog/);
  assert.match(css, /height: min\(78dvh, 720px\)/);
  assert.match(css, /\.ui-trial__modal-dialog \.ui-trial__spot-detail-photos \{[\s\S]*?grid-auto-columns: 100%/);
  assert.match(css, /\.ui-trial__explore-window-dialog\.is-expanded/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.ui-trial__explore-window-filters select \{[\s\S]*?min-height: 44px/);
  assert.match(css, /@keyframes ui-trial-spot-sheet-enter/);
  assert.match(css, /animation: ui-trial-spot-window-enter 220ms ease-out;/);
  assert.match(css, /animation: ui-trial-spot-sheet-enter 220ms ease-out;/);
  assert.doesNotMatch(css, /animation: ui-trial-(?:spot-window|spot-sheet)-enter[^;]*\bboth\b/);
  assert.match(css, /body:has\(\.ui-trial__explore-window\) \.ui-trial__mobile-nav/);
  assert.match(css, /\.ui-trial__modal:not\(\.ui-trial__explore-window\) \{[\s\S]*?z-index: 120/);
  assert.match(css, /\.community-contribution\s*\{/);
  assert.match(css, /\.ui-trial__planner-days\s*\{/);
  assert.match(css, /\.ui-trial__transit-legs/);
  assert.doesNotMatch(css, /!important/);
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
  const [entry, index, packageJson] = await Promise.all([
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/index.html", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(entry, /PilgrimageApp/);
  assert.match(index, /og\.png/);
  assert.equal(JSON.parse(packageJson).version, "3.0.3");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});

test("GitHub Pages ships public release metadata", async () => {
  const [index, robots, sitemap, manifestRaw, pagesMain, siteRaw] = await Promise.all([
    readFile(new URL("../github-pages/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../public/site.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../content/site.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const site = JSON.parse(siteRaw);

  assert.match(index, /rel="canonical" href="https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/"/);
  assert.match(index, /property="og:image"/);
  assert.match(index, /name="twitter:card" content="summary_large_image"/);
  assert.match(index, /%BASE_URL%favicon\.svg/);
  assert.match(index, /%BASE_URL%site\.webmanifest/);
  assert.match(robots, /Sitemap: https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/yukachiii\.github\.io\/hasunosora-pilgrimage\/<\/loc>/);
  assert.equal(manifest.start_url, "/hasunosora-pilgrimage/");
  assert.equal(manifest.short_name, "蓮ノ旅");
  assert.ok(site.heroImages.length >= 3);
  assert.equal(new Set(site.heroImages).size, site.heroImages.length);
  assert.match(pagesMain, /chooseHeroIndex/);
  assert.match(pagesMain, /image === previousImage/);
  await Promise.all(
    [site.heroImage, ...site.heroImages].map((image) =>
      access(new URL(`../public${image}`, import.meta.url)),
    ),
  );
  await access(new URL("../public/favicon.svg", import.meta.url));
});

test("Windows auto updater fast-forwards trusted pushes and health-checks the receiver", async () => {
  const [updater, installer, wrapper, gitignore] = await Promise.all([
    readFile(new URL("../update-community.ps1", import.meta.url), "utf8"),
    readFile(new URL("../install-community-auto-update.ps1", import.meta.url), "utf8"),
    readFile(new URL("../install-community-auto-update.bat", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.match(updater, /ExpectedOrigin = "https:\/\/github\.com\/Yukachiii\/hasunosora-pilgrimage\.git"/);
  assert.match(updater, /"fetch", "--quiet", "origin", "main"/);
  assert.match(updater, /"merge", "--ff-only", \$remoteCommit/);
  assert.match(updater, /core\.hooksPath=NUL/);
  assert.match(updater, /\$ErrorActionPreference = "Continue"[\s\S]+\$exitCode = \$LASTEXITCODE/);
  assert.match(updater, /Tracked local changes exist/);
  assert.match(updater, /Stop-ScheduledTask/);
  assert.match(updater, /Start-ScheduledTask/);
  assert.match(updater, /127\.0\.0\.1:\$\{HealthPort\}\/health/);
  assert.match(updater, /npmOutput = @\(& \$ResolvedNpmExe ci --no-audit --no-fund/);
  assert.match(updater, /\$npmExitCode = \$LASTEXITCODE/);
  assert.match(updater, /\$currentDependencyHash -and[\s\S]+\$storedDependencyHash -and/);
  assert.doesNotMatch(updater, /reset\s+--hard|clean\s+-[a-z]*f/i);
  assert.match(installer, /Hasunosora Community Auto Update/);
  assert.match(installer, /-UserId "SYSTEM"/);
  assert.match(installer, /-RepetitionInterval \(New-TimeSpan -Minutes \$IntervalMinutes\)/);
  assert.match(wrapper, /install-community-auto-update\.ps1/);
  assert.match(gitignore, /\/private\/community-update\//);
});

test("Mapbox map and route integration stays guarded", async () => {
  const [entry, map, css] = await Promise.all([
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(entry, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.match(map, /mapbox:\/\/styles\/mapbox\/streets-v12/);
  assert.match(map, /map\.on\("style\.load"[\s\S]+map\.setLanguage\("ja"\)/);
  assert.doesNotMatch(map, /style: "mapbox:\/\/styles\/mapbox\/standard",\s+language: "ja"/);
  assert.match(map, /optimized-trips\/v1/);
  assert.match(map, /directions\/v5/);
  assert.match(map, /optimizeWaypointOrder/);
  assert.match(map, /if \(mapState !== "ready" \|\| !routeLinesRef\.current\.length\) return/);
  assert.doesNotMatch(map, /routeServiceUrl|ServerRoutePlan|source: "server"/);
  assert.match(map, /planned: `\$\{import\.meta\.env\.BASE_URL\}map-markers\/green\.png`/);
  assert.match(map, /card: `\$\{import\.meta\.env\.BASE_URL\}map-markers\/blue\.png`/);
  assert.match(map, /collaboration: `\$\{import\.meta\.env\.BASE_URL\}map-markers\/yellow\.png`/);
  assert.match(map, /createNumberedMarkerImage/);
  assert.match(map, /"icon-image": \["get", "markerImageId"\]/);
  assert.doesNotMatch(map, /"text-field": \["get", "indexLabel"\]/);
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
  assert.match(app, /おすすめの順番に並べる/);
  assert.match(app, /const \[optimizeOrder, setOptimizeOrder\] = useState\(false\)/);
  assert.match(app, /移動時間と訪問順を自動で計算します/);
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
  assert.match(app, /aria-label="訪問日"/);
  assert.match(app, /aria-label="出発時刻"/);
  assert.match(app, /aria-label="移動手段"/);
  assert.doesNotMatch(app, /公共交通（準備中）/);
  assert.match(yahooTransit, /transit\.yahoo\.co\.jp\/search\/result/);
  assert.match(yahooTransit, /m1: paddedMinute\[0\]/);
  assert.match(yahooTransit, /m2: paddedMinute\[1\]/);
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
  assert.match(planner, /maximumItineraryStops = 25/);
  assert.equal(
    collaborations.find((item) => item.id === "ishikawa-dai-kanko-2").locations.length,
    13,
  );
  assert.equal(
    collaborations.find((item) => item.id === "kaga-onsen-2026").locations.length,
    9,
  );
});

test("API dashboard covers only services used by the public system", async () => {
  const [adminApp, localServer, envExample, packageJson] = await Promise.all([
    readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(adminApp, /API使用状況/);
  assert.match(adminApp, /カードモデル地の確認/);
  assert.match(adminApp, /信頼度は管理用です/);
  assert.match(adminApp, /投稿受付と認証/);
  assert.match(adminApp, /Mapbox公式Statistics/);
  assert.match(localServer, /\/api\/admin\/community-usage/);
  assert.doesNotMatch(adminApp + localServer + envExample + packageJson, /Google Routes|route-usage|ROUTE_USAGE|GOOGLE_ROUTES|vinext|drizzle-orm/);
  await Promise.all([
    "../app/page.tsx",
    "../app/api/routes/plan/route.ts",
    "../db/schema.ts",
    "../worker/index.ts",
  ].map((path) => assert.rejects(access(new URL(path, import.meta.url)))));
});

test("spot photos can be used as readable card backgrounds", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /spotPhotoGroups\[spot\.id\]\?\.\[0\] \?\? spot\.imageUrl/);
  assert.match(app, /selected-map-detail__photo-grid/);
  assert.match(app, /imageUrl \? " has-image"/);
  assert.match(app, /spot\.activityRecords/);
  assert.match(app, /spot\.sehasEpisodes/);
  assert.match(css, /\.spot-card\.has-image/);
  assert.match(css, /\.spot-card__episodes/);
  assert.match(css, /var\(--spot-image\)/);
});

test("local admin writes publishable files before an explicit GitHub push", async () => {
  const [adminApp, localMain, localServer, startScript, pagesMain, adminCss] =
    await Promise.all([
      readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("../local-admin/main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../server.mjs", import.meta.url), "utf8"),
      readFile(new URL("../start-admin.ps1", import.meta.url), "utf8"),
      readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    ]);

  assert.match(adminApp, /exifr/);
  assert.match(adminApp, /makePublicDerivative/);
  assert.match(adminApp, /スポットを編集/);
  assert.match(localMain, /<AdminApp/);
  assert.match(localServer, /127\.0\.0\.1/);
  assert.match(localServer, /isPrivateIpv4/);
  assert.match(localServer, /lanAdminUrl/);
  assert.match(localServer, /hasunosora-pilgrimage-admin/);
  assert.match(localServer, /\/api\/admin\/identity/);
  assert.match(startScript, /\$Port = 8766/);
  assert.match(startScript, /Test-PortInUse/);
  assert.match(startScript, /\/api\/admin\/identity/);
  assert.match(startScript, /-EncodedCommand/);
  assert.match(startScript, /\$SshTarget = "yuimarine@192\.168\.0\.4"/);
  assert.match(startScript, /"-N"/);
  assert.match(startScript, /"-L" "\$\{Port\}:127\.0\.0\.1:\$\{Port\}"/);
  assert.match(startScript, /"ExitOnForwardFailure=yes"/);
  assert.match(startScript, /Start-VerifiedAdminBrowser 120/);
  assert.match(startScript, /ValidateSet\("admin", "no-open", "local", "local-no-open"\)/);
  assert.match(localMain, /localNetworkUrl/);
  assert.match(adminApp, /スマホから管理画面を開く/);
  assert.match(localServer, /writeJsonIfChanged/);
  assert.match(localServer, /writeToken/);
  assert.match(localServer, /siteHeroImages/);
  assert.match(localServer, /hero-candidate/);
  assert.match(localServer, /トップ画像は1枚以上残してください/);
  assert.match(adminApp, /トップ画像候補/);
  assert.match(adminApp, /changeHeroCandidate/);
  assert.match(adminApp, /handleFileDrop/);
  assert.match(adminApp, /publishAll/);
  assert.match(adminApp, /画像ごとの配置先/);
  assert.match(adminApp, /GPSから自動選択/);
  assert.match(adminApp, /spotManuallySelected/);
  assert.match(adminApp, /automaticSpotDistanceLimitM/);
  assert.match(adminApp, /fileIdentity/);
  assert.match(adminApp, /PUBLIC VERSION/);
  assert.match(adminApp, /RANDOM HERO/);
  assert.match(adminApp, /ADMIN \/ CONTENT MANAGEMENT/);
  assert.match(adminCss, /\.admin-intro__cover/);
  assert.match(adminCss, /\.hero-candidate-summary/);
  assert.match(adminCss, /@media \(max-width: 600px\)[\s\S]*?\.admin-tabs\s*\{[^}]*position:\s*fixed/s);
  assert.match(localServer, /"add", "--", "content", "public\/photos"/);
  assert.match(localServer, /site-version/);
  assert.match(localServer, /const replacement = nextMedia\.find/);
  assert.match(startScript, /build:admin/);
  assert.match(startScript, /\$BindHost = "0\.0\.0\.0"/);
  assert.match(pagesMain, /content\/site\.json/);
  assert.match(pagesMain, /import\.meta\.glob/);
});

test("planner persistence, opening hours, and today mode avoid extra route requests", async () => {
  const [app, storage, routePlanner, adminApp, spotsSource, css, contributionPanel] = await Promise.all([
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/planner-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/route-planner.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/spots.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/CommunityContributionPanel.tsx", import.meta.url), "utf8"),
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
  assert.equal((app.match(/当日の予定を見る/g) ?? []).length, 1);
  assert.doesNotMatch(app, /当日ページを開く|today-mode-open/);
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
  const activeExploreNavAction = app.match(/if \(activeExplorePanel\) \{[\s\S]*?return;[\s\S]*?\}/)?.[0] ?? "";
  assert.match(activeExploreNavAction, /closeExplorePanel\(\);/);
  assert.match(activeExploreNavAction, /setIsExplorePickerOpen\(true\);/);
  assert.doesNotMatch(activeExploreNavAction, /setIsExplorePickerOpen\(false\);/);
  assert.match(app, /setIsExplorePickerOpen\(\(current\) => !current\);/);
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
  assert.match(app, /className="itinerary-drag-handle"/);
  assert.match(app, /data-itinerary-spot-id=\{spot\.id\}/);
  assert.match(app, /onPointerDown=\{\(event\) => startItineraryDrag\(event, spot\.id\)\}/);
  assert.match(app, /list\.setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /setItineraryDragPreview\(nextOrder\)/);
  assert.match(app, /row\.cloneNode\(true\)/);
  assert.match(app, /document\.body\.appendChild\(overlay\)/);
  assert.match(app, /drag\.overlay\.style\.transform = `translate3d/);
  assert.match(app, /removeItineraryDragOverlay\(drag\.overlay\)/);
  assert.match(app, /itineraryFlipPositionsRef/);
  assert.match(app, /row\.animate\(/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  const moveItineraryDrag = app.match(/function moveItineraryDrag\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.doesNotMatch(moveItineraryDrag, /setItineraryIds|invalidateRoute/);
  const finishItineraryDrag = app.match(/function finishItineraryDrag\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(finishItineraryDrag, /setItineraryIds\(drag\.previewIds\);/);
  assert.match(finishItineraryDrag, /invalidateRoute\(\);/);
  assert.match(finishItineraryDrag, /sameIdOrder\(drag\.previewIds, drag\.originalIds\)/);
  assert.match(app, /onPointerUp=\{finishItineraryDrag\}/);
  assert.match(app, /onPointerCancel=\{cancelItineraryDrag\}/);
  assert.match(app, /onLostPointerCapture=\{cancelItineraryDrag\}/);
  assert.match(app, /window\.requestAnimationFrame\(runItineraryDragAutoScroll\)/);
  assert.match(app, /scrollingElement\.scrollTop \+= amount/);
  assert.doesNotMatch(app, /function runItineraryDragAutoScroll\([\s\S]*?window\.scrollBy/);
  assert.match(app, /draggedItinerarySpotId !== null \|\|[\s\S]*?itinerarySpots\.length < 2/);
  assert.match(app, /event\.key === "ArrowUp" \? -1 : 1/);
  assert.doesNotMatch(app, /isEditingItineraryOrder|順序変更を完了|順序を変更/);
  assert.match(app, /className="transit-search-panel" id="transit-search-panel"/);
  assert.match(app, /className="today-mode__tools"/);
  assert.doesNotMatch(app, /className="selection-tray"/);
  assert.doesNotMatch(app, /同意画面をもう一度確認する/);
  assert.match(app, /className="hero-magazine-rule"/);
  assert.match(app, /このサイトで扱うデータ/);
  assert.match(app, /サイト側で予定を保管することはありません/);
  assert.match(app, /個人で運営する非公式サイト/);
  assert.match(app, /communitySubmissionsEnabled \? "写真や新しいスポットを送る" : "投稿機能は準備中"/);
  assert.match(app, /hidden=\{activePage !== "explore"\}/);
  assert.match(app, /sectionId === "community-contribution"[\s\S]{0,100}focus\(\{ preventScroll: true \}\)/);
  assert.match(contributionPanel, /gps as readGps/);
  assert.match(contributionPanel, /AUTOMATIC_SPOT_DISTANCE_LIMIT_M/);
  assert.match(contributionPanel, /位置情報から「\{photoLocation\.spotName\}」を選びました/);
  assert.match(contributionPanel, /写真を選ぶ/);
  assert.match(css, /\.community-contribution__file-picker:focus-within/);
  assert.doesNotMatch(contributionPanel, /payload[\s\S]{0,180}(?:gps|latitude|longitude)/i);
  assert.doesNotMatch(app, /scrollIntoView\(\{ behavior: "smooth" \}\)/);
  assert.doesNotMatch(app, /非公式の試作サイト/);
  assert.match(app, /mapReturnSection/);
  assert.match(app, /スポット一覧へ戻る/);
  assert.match(app, /カードモデル地へ戻る/);
  assert.match(app, /activeExplorePanel/);
  const exploreOverlayNavigation = app.match(/if \(page === "explore" && \(sectionId === "spots" \|\| sectionId === "card-models"\)\) \{[\s\S]*?return;[\s\S]*?\}/)?.[0] ?? "";
  assert.doesNotMatch(exploreOverlayNavigation, /setActivePage|pushState|location\.hash/);
  assert.match(app, /className=\{`explore-sheet\$\{isExploreSheetClosing/);
  assert.match(app, /aria-label="一覧を切り替える"/);
  assert.match(app, /spotSourceFilter/);
  assert.match(app, /With×MEETS/);
  assert.match(app, /className="explore-sheet__grab-zone"/);
  assert.match(app, /isExploreSheetExpanded/);
  assert.match(app, /moveExploreSheetDrag/);
  assert.match(app, /panel\.style\.height = `\$\{nextHeight\}px`/);
  assert.match(app, /settleExploreSheet\(deltaY <= -36\)/);
  assert.match(app, /deltaY >= collapsedDistance \+ 96/);
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
  assert.match(spotsSource, /openingHoursCheckedAt/);
  assert.match(css, /\.today-mode__dialog/);
  assert.match(css, /\.spot-card__hours/);
  assert.match(css, /Public page: touch-first layout/);
  assert.match(css, /\.mobile-nav/);
  assert.match(css, /\.mobile-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(css, /\.mobile-explore-picker\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows:\s*repeat\(2,/s);
  assert.match(css, /animation:\s*mobile-explore-picker-grow/);
  assert.match(css, /\.explore-sheet\.is-closing \.explore-sheet__panel/);
  assert.match(css, /\.explore-sheet__panel\.is-expanded/);
  assert.match(css, /\.explore-sheet__panel\.is-dragging/);
  assert.match(css, /height:\s*calc\(100dvh - 76px - env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@keyframes explore-sheet-exit/);
  assert.match(css, /@keyframes explore-sheet-content-enter/);
  assert.match(css, /button\[aria-current="page"\]/);
  assert.match(css, /\.transit-search-panel__confirmed/);
  assert.match(css, /\.transit-search-panel__progress/);
  assert.match(css, /\.map-layout\s*\{[^}]*align-items:\s*stretch/s);
  assert.match(css, /\.route-planner\s*\{[^}]*align-self:\s*stretch[^}]*height:\s*auto[^}]*max-height:\s*none/s);
  assert.match(css, /\.route-workspace__controls/);
  assert.match(css, /\.itinerary-drag-handle\s*\{[^}]*touch-action:\s*none/s);
  assert.match(css, /\.itinerary-editor li\.is-dragging\s*\{[^}]*box-shadow:/s);
  assert.match(css, /\.itinerary-drag-overlay\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s);
  assert.match(css, /grid-template-areas:\s*"spot remove drag"\s*"stay remove drag"/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.planner-overview\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.doesNotMatch(css, /scroll-snap-(?:type|align)/);
  assert.match(css, /\.route-planner \.itinerary-editor > ol\s*\{[^}]*max-height:\s*none/s);
  assert.match(css, /@media \(max-width:\s*1080px\)[\s\S]*?\.route-planner\s*\{[^}]*max-height:\s*none/s);
  const rightColumn = app.match(/<aside className="route-planner"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(rightColumn, /訪問するスポット/);
  assert.doesNotMatch(rightColumn, /journey-start|travel-modes|collaboration-route-fill/);
  assert.match(app, /className="route-workspace" id="planner"/);
  assert.match(app, /予定の経路/);
  assert.match(app, /activePage === "planner" \? itinerarySpots : spots/);
  assert.match(app, /className="planner-overview"/);
  assert.match(app, /className="planner-conditions"/);
  assert.doesNotMatch(app, />予定条件</);
  assert.match(app, /planner-create-bar/);
  assert.match(app, /automaticRouteAttemptRef/);
  assert.match(app, /window\.setTimeout\(\(\) => \{[\s\S]*?searchRoute\(\);[\s\S]*?\}, 650\)/);
  assert.match(app, /自動で予定を作成します/);
  assert.match(app, /PLANNER_SHARE_MESSAGE = "訪問予定を共有します。\\n#蓮ノ旅"/);
  assert.match(app, /text: PLANNER_SHARE_MESSAGE/);
  assert.match(app, /className="shared-plan-route-preview"/);
  assert.match(app, /routeRequest=\{sharedRouteRequest\}/);
  assert.match(app, /onRouteResult=\{handleSharedRouteResult\}/);
  assert.match(app, /createPlannerSnapshotFromSharedPlan/);
  assert.match(app, /現在この端末に保存されている予定は、共有された予定で上書きされます/);
  assert.match(app, /onClick=\{importSharedPlan\}/);
  assert.match(app, /window\.history\.replaceState\(window\.history\.state, "", plannerUrl\)/);
  assert.match(app, /setSharedPlan\(null\)/);
  assert.match(app, /function resetWindowScroll\(\)/);
  assert.match(app, /window\.history\.scrollRestoration = "manual"/);
  assert.match(app, /activePage !== "shared" \? \(\s*<MapboxPilgrimageMap/);
  assert.match(app, /activePage === "shared" && sharedActiveDay && sharedDaySpots\.length \? \(/);
  assert.match(css, /\.shared-plan-route-preview \.map-shell\s*\{[^}]*height:\s*390px/s);
  assert.match(css, /\.shared-plan-import\s*\{/);
  assert.match(app, /className="itinerary-spot-focus"/);
  assert.match(app, /focusSpotRequest=\{mapFocusRequest\}/);
  assert.doesNotMatch(app, /className="itinerary-add"|className="planner-find-spots"/);
  assert.doesNotMatch(app, /plannerStep|planner-steps/);
  assert.match(css, /\.app-page--planner \.map-column--route \.map-shell\s*\{[^}]*height:\s*340px/s);
  assert.match(css, /\.planner-create-bar\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.app-page--planner \.itinerary-editor > ol\s*\{[^}]*overflow:\s*visible/s);
});

test("Mapbox is the main map and the comparison version is removed", async () => {
  const [map, pagesEntry, pagesConfig, envExample, app, workflow] = await Promise.all([
    readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/PilgrimageApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
  ]);

  assert.match(map, /optimized-trips\/v1/);
  assert.match(map, /directions\/v5/);
  assert.match(map, /mapbox:\/\/styles\/mapbox\/streets-v12/);
  assert.match(map, /map\.setLanguage\("ja"\)/);
  assert.match(map, /if \(mapRef\.current === map\) mapRef\.current = null;\s*map\.remove\(\)/);
  assert.match(map, /if \(!listenersAttached \|\| mapRef\.current !== map\) return;/);
  assert.doesNotMatch(map, /if \(map\.getLayer\(SPOT_LAYER_ID\)\) \{\s*map\.off/);
  assert.match(map, /showCompass:\s*true/);
  assert.match(map, /map\.easeTo\(\{ center: \[selected\.lng, selected\.lat\], duration: 450 \}\)/);
  assert.match(map, /focusSpotRequest/);
  assert.match(map, /zoom: Math\.max\(map\.getZoom\(\), 15\.5\)/);
  assert.match(map, /viewMode !== "planner"/);
  assert.match(map, /fitPlannerView\(500\)/);
  assert.match(map, /map\.resize\(\)/);
  assert.match(map, /routeLinesRef/);
  assert.doesNotMatch(map, /cluster:\s*true/);
  assert.doesNotMatch(map, /SPOT_CLUSTER/);
  assert.doesNotMatch(map, /getClusterExpansionZoom/);
  assert.match(pagesEntry, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.doesNotMatch(pagesConfig, /github-pages\/mapbox\/index\.html/);
  assert.match(envExample, /VITE_MAPBOX_ACCESS_TOKEN/);
  assert.doesNotMatch(envExample, /MAPBOX_PUBLIC_ACCESS_TOKEN/);
  assert.match(workflow, /MAPBOX_ACCESS_TOKEN/);
  assert.match(app, /MapboxPilgrimageMap/);
  assert.match(app, /id="map-freeword-search"/);
  assert.match(app, /この場所に関連するカード/);
  assert.doesNotMatch(app, /Mapbox比較版|href="\.\/mapbox\//);
  await assert.rejects(access(new URL("../app/mapbox/page.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../github-pages/mapbox/index.html", import.meta.url)));
});
