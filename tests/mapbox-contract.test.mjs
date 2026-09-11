import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("public deployment supplies the Mapbox token expected by the entry point", async () => {
  const [entry, workflow, envExample] = await Promise.all([
    readFile(new URL("../github-pages/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  const tokenName = "VITE_MAPBOX_ACCESS_TOKEN";

  assert.ok(entry.includes(tokenName));
  assert.ok(workflow.includes(`${tokenName}: \${{ secrets.MAPBOX_ACCESS_TOKEN }}`));
  assert.ok(envExample.includes(`${tokenName}=`));
});

test("Mapbox uses the Japanese street map and both supported route endpoints", async () => {
  const map = await readFile(new URL("../app/MapboxPilgrimageMap.tsx", import.meta.url), "utf8");

  assert.ok(map.includes('style: "mapbox://styles/mapbox/streets-v12"'));
  assert.match(map, /map\.on\("style\.load"[\s\S]+map\.setLanguage\("ja"\)/);
  assert.ok(map.includes("api.mapbox.com/optimized-trips/v1/"));
  assert.ok(map.includes("api.mapbox.com/directions/v5/"));
});

test("every Mapbox marker kind has a public image", async () => {
  await Promise.all(["red", "yellow", "blue", "green"].map((color) =>
    access(new URL(`../public/map-markers/${color}.png`, import.meta.url))));
});
