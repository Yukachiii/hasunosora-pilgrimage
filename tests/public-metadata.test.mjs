import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const publicOrigin = "https://yukachiii.github.io/hasunosora-pilgrimage/";

async function readText(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function referencedGuideImages(source) {
  return [...source.matchAll(/guide\/([a-z0-9._-]+\.(?:png|jpe?g|webp))/gi)]
    .map((match) => match[1]);
}

test("public release metadata uses one version and one canonical origin", async () => {
  const [index, robots, sitemap, manifestRaw, siteRaw, packageRaw] = await Promise.all([
    readText("../github-pages/index.html"),
    readText("../public/robots.txt"),
    readText("../public/sitemap.xml"),
    readText("../public/site.webmanifest"),
    readText("../content/site.json"),
    readText("../package.json"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const site = JSON.parse(siteRaw);
  const packageJson = JSON.parse(packageRaw);

  assert.match(site.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.version, site.version);
  assert.ok(index.includes(`<html lang="ja">`));
  assert.ok(index.includes(`<link rel="canonical" href="${publicOrigin}"`));
  assert.ok(index.includes('property="og:image"'));
  assert.ok(index.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(robots.includes(`Sitemap: ${publicOrigin}sitemap.xml`));
  assert.ok(sitemap.includes(`<loc>${publicOrigin}</loc>`));
  assert.equal(manifest.lang, "ja");
  assert.equal(manifest.start_url, new URL(publicOrigin).pathname);
  assert.equal(manifest.scope, new URL(publicOrigin).pathname);
});

test("non-production pages cannot be indexed", async () => {
  const trialEntries = await Promise.all([
    readText("../github-pages/guide-test/index.html"),
    readText("../github-pages/legacy/index.html"),
    readText("../github-pages/ui-test/index.html"),
  ]);

  for (const entry of trialEntries) {
    assert.ok(entry.includes('name="robots" content="noindex, nofollow"'));
  }
});

test("public metadata and guide pages refer only to existing assets", async () => {
  const [siteRaw, manifestRaw, publicGuide, trialGuide] = await Promise.all([
    readText("../content/site.json"),
    readText("../public/site.webmanifest"),
    readText("../github-pages/ui-test/UiTrialApp.tsx"),
    readText("../github-pages/guide-test/GuideTestPage.tsx"),
  ]);
  const site = JSON.parse(siteRaw);
  const manifest = JSON.parse(manifestRaw);

  assert.ok(Array.isArray(site.heroImages) && site.heroImages.length >= 2,
    "at least two hero images are required for rotation");
  assert.equal(new Set(site.heroImages).size, site.heroImages.length,
    "hero images must not contain duplicates");

  const assetPaths = new Set([
    site.heroImage,
    ...site.heroImages,
    ...manifest.icons.map((icon) => `/${icon.src}`),
    "/og.png",
    "/favicon-32.png",
    "/apple-touch-icon.png",
    "/brand/hero-logo-c.png",
  ].filter(Boolean));
  await Promise.all([...assetPaths].map((assetPath) =>
    access(new URL(`../public/${assetPath.replace(/^\//, "")}`, import.meta.url))));

  const guideImages = new Set([
    ...referencedGuideImages(publicGuide),
    ...referencedGuideImages(trialGuide),
  ]);
  assert.ok(guideImages.size > 0, "no guide images are referenced");
  await Promise.all([...guideImages].map((image) =>
    access(new URL(`../public/guide/${image}`, import.meta.url))));
});

test("production and UI test entries use separate persistence and submission targets", async () => {
  const [productionEntry, testEntry, planner] = await Promise.all([
    readText("../github-pages/main.tsx"),
    readText("../github-pages/ui-test/main.tsx"),
    readText("../github-pages/ui-test/use-live-planner.ts"),
  ]);

  assert.ok(productionEntry.includes('runtime="production"'));
  assert.ok(productionEntry.includes('submissionPath="/api/submissions"'));
  assert.ok(!productionEntry.includes('submissionPath="/api/ui-test-submissions"'));
  assert.ok(testEntry.includes('runtime="test"'));
  assert.ok(testEntry.includes('submissionPath="/api/ui-test-submissions"'));
  assert.ok(planner.includes("PLANNER_DRAFT_COOKIE_KEY"));
  assert.ok(planner.includes("TEST_PLANNER_STORAGE_KEY"));
});
