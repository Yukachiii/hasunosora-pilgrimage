import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentFixture, fileExists, stopProcess, waitForFile } from "./helpers/deployment-fixture.mjs";

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

test("the admin launcher's production defaults stay private", async () => {
  const launcher = await readFile(new URL("../start-admin-server.ps1", import.meta.url), "utf8");
  assert.match(launcher, /\[int\]\$Port = 8766/);
  assert.match(launcher, /& \$NodeExe[^\r\n]* --bind 127\.0\.0\.1 --port \$Port/);
});

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPowerShell(command) {
  const encodedCommand = Buffer.from(
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${command}`,
    "utf16le",
  ).toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test("Windows startup registration preserves Japanese paths, creates its folder, and replaces only the legacy entry", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const testDirectory = await mkdtemp(
    path.join(fileURLToPath(new URL("..", import.meta.url)), ".admin-startup-test-"),
  );
  const projectDirectory = path.join(testDirectory, "日本語の巡礼 [確認] & space");
  const startupDirectory = path.join(testDirectory, "日本語のスタートアップ", "not-created");
  const shortcutPath = path.join(startupDirectory, "Hasunosora Admin Server.lnk");
  const legacyPath = path.join(startupDirectory, "Hasunosora Admin Server.cmd");
  const unrelatedPath = path.join(startupDirectory, "Other application.cmd");
  const batchPath = path.join(projectDirectory, "start-admin-server.bat");
  const installerPath = path.join(projectDirectory, "install-admin-autostart.ps1");

  try {
    await mkdir(projectDirectory);
    await copyFile(new URL("../install-admin-autostart.ps1", import.meta.url), installerPath);
    await writeFile(batchPath, "@echo off\r\necho launched> startup-launched.txt\r\nexit /b 0\r\n", "ascii");
    const install = () => {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath,
        "-StartupDirectory", startupDirectory,
      ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    };
    install();
    const shortcut = JSON.parse(windowsPowerShell(
      `$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut(${powerShellLiteral(shortcutPath)}); ` +
      "@{TargetPath=$shortcut.TargetPath; WorkingDirectory=$shortcut.WorkingDirectory; WindowStyle=$shortcut.WindowStyle} | ConvertTo-Json -Compress",
    ));
    assert.deepEqual(shortcut, {
      TargetPath: batchPath,
      WorkingDirectory: projectDirectory,
      WindowStyle: 1,
    });

    await writeFile(legacyPath, "Legacy registration\n", "ascii");
    await writeFile(unrelatedPath, "Unrelated registration\n", "ascii");
    install();
    install();
    assert.deepEqual((await readdir(startupDirectory)).sort(), [
      "Hasunosora Admin Server.lnk", "Other application.cmd",
    ]);
    assert.equal(await readFile(unrelatedPath, "ascii"), "Unrelated registration\n");

    windowsPowerShell(`Start-Process -FilePath ${powerShellLiteral(shortcutPath)} -WindowStyle Hidden -Wait`);
    assert.equal((await readFile(path.join(projectDirectory, "startup-launched.txt"), "ascii")).trim(), "launched");
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});

test("a Windows admin build retry detects a concurrently started server without rebuilding again", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const fixture = await deploymentFixture();
  let identityReady = false;
  let launcher;
  const identityServer = createServer((_request, response) => {
    if (_request.url !== "/api/admin/identity") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(identityReady ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ application: "hasunosora-pilgrimage-admin", schemaVersion: 1 }));
  });

  try {
    await new Promise((resolve) => identityServer.listen(0, "127.0.0.1", resolve));
    const port = identityServer.address().port;
    const gate = path.join(fixture.project, "build-hold.txt");
    await writeFile(gate, "hold");
    await writeFile(path.join(fixture.project, "build-fail.txt"), "fail");
    launcher = fixture.launcher(port);
    await waitForFile(path.join(fixture.project, "build-started.txt"), launcher);
    identityReady = true;
    await rm(gate);
    const result = await launcher.done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await fixture.eventLines(), ["build"]);
    assert.equal(await fileExists(path.join(fixture.project, "node-started.txt")), false);
  } finally {
    identityReady = true;
    await stopProcess(launcher);
    identityServer.closeAllConnections();
    await new Promise((resolve) => identityServer.close(resolve));
    await fixture.cleanup();
  }
});

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForOutput(process, pattern = /./) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pattern.test(process.output())) return;
    if (process.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`Process did not reach its waiting UI: ${process.output()}`);
}

const windowsDeploymentTest = { skip: process.platform !== "win32", timeout: 45_000 };

test("Windows verifies unknown dependencies instead of trusting an existing node_modules", windowsDeploymentTest, async () => {
  const fixture = await deploymentFixture();
  let updater;
  try {
    updater = fixture.update();
    const result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["stop", "ci", "start"]);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), fixture.initialCommit);
    const storedHash = (await readFile(fixture.dependencyHash, "utf8")).trim();
    assert.notEqual(storedHash, "");
    assert.equal(await readFile(path.join(fixture.project, "ci-started.txt"), "utf8"), fixture.project);
    assert.equal(await fileExists(fixture.pending), false);
    updater = fixture.update();
    assert.equal((await updater.done).code, 0, updater.output());
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["stop", "ci", "start"]);
    assert.equal((await readFile(fixture.dependencyHash, "utf8")).trim(), storedHash);
  } finally { await stopProcess(updater); await fixture.cleanup(); }
});

test("Windows dependency updates also defer for an already running legacy admin without a lock", windowsDeploymentTest, async () => {
  const fixture = await deploymentFixture();
  let updater;
  try {
    await fixture.seedDeployment();
    await fixture.candidate();
    await writeFile(path.join(fixture.project, "legacy-admin.txt"), "running");
    updater = fixture.update();
    const result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), []);
    assert.equal(fixture.git("rev-parse", "HEAD"), fixture.initialCommit);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), fixture.initialCommit);
    assert.equal(await fileExists(fixture.pending), false);
  } finally { await stopProcess(updater); await fixture.cleanup(); }
});

test("the actual Windows admin allows code updates but defers dependency merges throughout build and node lifetime", windowsDeploymentTest, async () => {
  const fixture = await deploymentFixture();
  let launcher;
  let updater;
  try {
    await fixture.seedDeployment();
    const previousHash = await readFile(fixture.dependencyHash, "utf8");
    const codeCandidate = await fixture.candidate("1.0.0", "1.0.1");
    const buildGate = path.join(fixture.project, "build-hold.txt");
    const nodeGate = path.join(fixture.project, "node-hold.txt");
    await writeFile(buildGate, "hold");
    await writeFile(nodeGate, "hold");
    const port = await freeLoopbackPort();
    launcher = fixture.launcher(port);
    await waitForFile(path.join(fixture.project, "build-started.txt"), launcher);
    updater = fixture.update();
    let result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(fixture.git("rev-parse", "HEAD"), codeCandidate);
    assert.equal((await readFile(fixture.dependencyHash, "utf8")).trim(), previousHash.trim());
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["build", "merge", "stop", "start"]);
    assert.equal(await fileExists(path.join(fixture.project, "ci-started.txt")), false);

    const candidate = await fixture.candidate("2.0.0", "1.0.2");
    const deployedBefore = await readFile(fixture.deployed, "utf8");
    const hashBefore = await readFile(fixture.dependencyHash, "utf8");
    updater = fixture.update();
    result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(fixture.git("rev-parse", "HEAD"), codeCandidate);
    assert.equal(await readFile(fixture.deployed, "utf8"), deployedBefore);
    assert.equal(await readFile(fixture.dependencyHash, "utf8"), hashBefore);
    assert.equal(await readFile(fixture.receiverState, "utf8"), "Running");
    assert.equal(await fileExists(fixture.pending), false);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["build", "merge", "stop", "start"]);
    await rm(buildGate);
    await waitForFile(path.join(fixture.project, "node-started.txt"), launcher);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.project, "node-started.txt"), "utf8")), ["--bind", "127.0.0.1", "--port", String(port)]);
    updater = fixture.update();
    result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(await fileExists(path.join(fixture.project, "ci-started.txt")), false);
    assert.equal(fixture.git("rev-parse", "HEAD"), codeCandidate);
    assert.equal(await readFile(fixture.deployed, "utf8"), deployedBefore);
    assert.equal(await readFile(fixture.dependencyHash, "utf8"), hashBefore);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["build", "merge", "stop", "start", "node"]);
    await rm(nodeGate);
    result = await launcher.done;
    assert.equal(result.code, 0, result.output);
    updater = fixture.update();
    result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(fixture.git("rev-parse", "HEAD"), candidate);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), candidate);
    assert.notEqual((await readFile(fixture.dependencyHash, "utf8")).trim(), previousHash.trim());
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["build", "merge", "stop", "start", "node", "merge", "stop", "ci", "start"]);
  } finally { await stopProcess(updater); await stopProcess(launcher); await fixture.cleanup(); }
});

test("Windows admin startup waits through an exclusive install, its failure, and a successful retry", windowsDeploymentTest, async () => {
  const fixture = await deploymentFixture();
  let launcher;
  let freshLauncher;
  let updater;
  try {
    await fixture.seedDeployment();
    const previousHash = await readFile(fixture.dependencyHash, "utf8");
    const candidate = await fixture.candidate();
    const failure = path.join(fixture.project, "ci-fail.txt");
    const ciGate = path.join(fixture.project, "ci-hold.txt");
    const nodeGate = path.join(fixture.project, "node-hold.txt");
    await writeFile(failure, "fail");
    await writeFile(ciGate, "hold");
    await writeFile(nodeGate, "hold");
    updater = fixture.update();
    await waitForFile(path.join(fixture.project, "ci-started.txt"), updater);
    launcher = fixture.launcher(await freeLoopbackPort());
    await waitForOutput(launcher);
    assert.equal(launcher.child.exitCode, null, launcher.output());
    assert.equal(await fileExists(path.join(fixture.project, "build-started.txt")), false);
    assert.equal(await fileExists(path.join(fixture.project, "node-started.txt")), false);
    await rm(ciGate);
    let result = await updater.done;
    assert.equal(result.code, 1, result.output);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["merge", "stop", "ci"]);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), fixture.initialCommit);
    assert.equal(await readFile(fixture.dependencyHash, "utf8"), previousHash);
    assert.equal(await readFile(fixture.receiverState, "utf8"), "Ready");
    assert.equal(await fileExists(fixture.pending), true);
    assert.equal(await fileExists(path.join(fixture.project, "build-started.txt")), false);
    // The updater has exited and no longer holds an exclusive handle. A fresh
    // process must be held back by the pending marker alone, before retrying.
    freshLauncher = fixture.launcher(await freeLoopbackPort());
    await waitForOutput(freshLauncher, /Waiting for/);
    assert.equal(freshLauncher.child.exitCode, null, freshLauncher.output());
    assert.equal(await fileExists(path.join(fixture.project, "build-started.txt")), false);
    assert.equal(await fileExists(path.join(fixture.project, "node-started.txt")), false);
    await rm(failure);
    updater = fixture.update();
    result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), candidate);
    assert.notEqual((await readFile(fixture.dependencyHash, "utf8")).trim(), previousHash.trim());
    assert.equal(await fileExists(fixture.pending), false);
    await waitForFile(path.join(fixture.project, "node-started.txt"), launcher);
    const mutations = (await fixture.eventLines()).filter((event) => event !== "fetch");
    assert.deepEqual(mutations.slice(0, 5), ["merge", "stop", "ci", "ci", "start"]);
    assert.ok(mutations.slice(5).every((event) => event === "build" || event === "node"));
    assert.ok(mutations.slice(5).includes("build"));
    assert.ok(mutations.slice(5).includes("node"));
    await rm(nodeGate);
    assert.equal((await launcher.done).code, 0, launcher.output());
    assert.equal((await freshLauncher.done).code, 0, freshLauncher.output());
  } finally { await stopProcess(updater); await stopProcess(launcher); await stopProcess(freshLauncher); await fixture.cleanup(); }
});

test("Windows does not deploy or restart against an old receiver listener after the task becomes Ready", windowsDeploymentTest, async () => {
  const fixture = await deploymentFixture();
  let updater;
  const oldListener = createServer((request, response) => {
    if (request.url !== "/health") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", application: "hasunosora-community-receiver", schemaVersion: 1 }));
  });
  try {
    await fixture.seedDeployment();
    const previousHash = await readFile(fixture.dependencyHash, "utf8");
    const deployedBefore = await readFile(fixture.deployed, "utf8");
    const candidate = await fixture.candidate("1.0.0", "1.0.1");
    await new Promise((resolve) => oldListener.listen(fixture.healthPort, "127.0.0.1", resolve));
    updater = fixture.update();
    let result = await updater.done;
    assert.equal(result.code, 1, result.output);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["merge", "stop"]);
    assert.equal(await readFile(fixture.receiverState, "utf8"), "Ready");
    assert.equal(await readFile(fixture.deployed, "utf8"), deployedBefore);
    assert.equal(await readFile(fixture.dependencyHash, "utf8"), previousHash);
    assert.equal(await fileExists(path.join(fixture.project, "ci-started.txt")), false);
    await new Promise((resolve) => oldListener.close(resolve));
    updater = fixture.update();
    result = await updater.done;
    assert.equal(result.code, 0, result.output);
    assert.equal((await readFile(fixture.deployed, "utf8")).trim(), candidate);
    assert.deepEqual((await fixture.eventLines()).filter((event) => event !== "fetch"), ["merge", "stop", "start"]);
  } finally {
    oldListener.closeAllConnections();
    if (oldListener.listening) await new Promise((resolve) => oldListener.close(resolve));
    await stopProcess(updater);
    await fixture.cleanup();
  }
});
