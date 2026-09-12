import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("automatic updates accept only trusted fast-forward changes", async () => {
  const updater = await readFile(new URL("../update-community.ps1", import.meta.url), "utf8");

  assert.ok(updater.includes(
    '$ExpectedOrigin = "https://github.com/Yukachiii/hasunosora-pilgrimage.git"',
  ));
  assert.match(updater, /"merge",\s*"--ff-only",\s*\$remoteCommit/);
  assert.doesNotMatch(updater, /\breset\s+--hard\b|\bclean\s+-[a-z]*f/i);
});

test("automatic update state cannot be committed", () => {
  const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(
    "git",
    ["check-ignore", "private/community-update/update.log"],
    { cwd: projectDirectory, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("the Windows startup launcher keeps the private admin server visible and loopback-only", async () => {
  const [installer, launcher] = await Promise.all([
    readFile(new URL("../install-admin-autostart.ps1", import.meta.url), "utf8"),
    readFile(new URL("../start-admin-server.bat", import.meta.url), "utf8"),
  ]);

  assert.match(installer, /\[Environment\+SpecialFolder\]::Startup/);
  assert.match(installer, /Hasunosora Admin Server\.cmd/);
  assert.match(installer, /call \"\{0\}\"/);
  assert.match(launcher, /node\.exe "server\.mjs" --bind 127\.0\.0\.1 --port 8766/);
  assert.match(launcher, /Keep this window open/);
  assert.doesNotMatch(launcher, /--bind 0\.0\.0\.0/);
});
