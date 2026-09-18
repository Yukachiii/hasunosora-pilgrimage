import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function spawnPowerShell(command, options = {}) {
  const source = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${command}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const done = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve({ code, output }));
    child.once("error", reject);
  });
  return { child, done, output: () => output };
}

export async function waitForFile(file, process = null, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch {}
    if (process && process.child.exitCode !== null) {
      assert.fail(`Process exited before ${file}: ${process.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`Timed out waiting for ${file}: ${process?.output() || ""}`);
}

export async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function stopProcess(process) {
  if (process?.child.pid && process.child.exitCode === null) {
    if (process.release) await process.release();
    else process.child.kill();
    await process.done;
  }
}

export async function deploymentFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hasunosora-deployment-"));
  const healthProbe = createServer();
  await new Promise((resolve) => healthProbe.listen(0, "127.0.0.1", resolve));
  const healthPort = healthProbe.address().port;
  await new Promise((resolve) => healthProbe.close(resolve));
  const project = path.join(directory, "日本語 [確認] & space");
  await mkdir(project);
  const resolvedGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true });
  assert.equal(resolvedGit.status, 0, resolvedGit.stderr);
  const gitExe = resolvedGit.stdout.trim().split(/\r?\n/)[0];
  const git = (...args) => {
    const result = spawnSync(gitExe, ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const events = path.join(project, "events.txt");
  const state = path.join(project, "private", "community-update");
  const dependencyLock = path.join(state, "dependencies.lock");
  const pending = path.join(state, "dependencies-pending.txt");
  const deployed = path.join(state, "deployed-commit.txt");
  const dependencyHash = path.join(state, "dependency-hash.txt");
  const receiverState = path.join(project, "receiver-state.txt");
  const packageFile = path.join(project, "package.json");
  const lockFile = path.join(project, "package-lock.json");
  const manifests = async (dependency = "1.0.0", version = "1.0.0") => {
    await writeFile(packageFile, `${JSON.stringify({ name: "fixture", version, dependencies: { fixture: dependency } }, null, 2)}\n`);
    await writeFile(lockFile, `${JSON.stringify({ name: "fixture", version, lockfileVersion: 3, packages: { "": { name: "fixture", version, dependencies: { fixture: dependency } } } }, null, 2)}\n`);
  };
  await manifests();
  await writeFile(path.join(project, ".gitignore"), "private/\nnode_modules/\n*.txt\n*.cmd\n*-shim.mjs\n*.ps1\nserver.mjs\n");
  git("init", "-b", "main");
  git("config", "user.name", "Deployment fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  git("add", "package.json", "package-lock.json", ".gitignore");
  git("commit", "-m", "initial");
  git("remote", "add", "origin", "https://github.com/Yukachiii/hasunosora-pilgrimage.git");
  const initialCommit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", initialCommit);
  await mkdir(state, { recursive: true });
  await mkdir(path.join(project, "node_modules"));
  await writeFile(path.join(project, "node_modules", "stale.txt"), "unverified dependencies");
  await writeFile(events, "");
  await writeFile(receiverState, "Running");
  await writeFile(path.join(project, "community-server.mjs"), "// Receiver tasks are mocked; this file is never executed.\n");
  await copyFile(new URL("../../update-community.ps1", import.meta.url), path.join(project, "update-community.ps1"));
  await copyFile(new URL("../../start-admin-server.ps1", import.meta.url), path.join(project, "start-admin-server.ps1"));
  await writeFile(path.join(project, "git-shim.mjs"), `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('fetch')) {
  // Never contact the configured trusted URL; refs are prepared in this fixture.
  fs.appendFileSync(${JSON.stringify(events)}, 'fetch\\n');
  process.exit(0);
}
if (args.includes('merge')) fs.appendFileSync(${JSON.stringify(events)}, 'merge\\n');
const result = spawnSync(${JSON.stringify(gitExe)}, args, { encoding: 'utf8', windowsHide: true });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`);
  await writeFile(path.join(project, "git.cmd"), `@"${process.execPath}" "%~dp0git-shim.mjs" %*\r\n`, "ascii");
  await writeFile(path.join(project, "npm-shim.mjs"), `
import fs from 'node:fs';
import path from 'node:path';
const project = ${JSON.stringify(project)};
const events = ${JSON.stringify(events)};
const installing = process.argv[2] === 'ci';
fs.appendFileSync(events, installing ? 'ci\\n' : 'build\\n');
fs.writeFileSync(path.join(project, installing ? 'ci-started.txt' : 'build-started.txt'), process.cwd());
const hold = path.join(project, installing ? 'ci-hold.txt' : 'build-hold.txt');
while (fs.existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 30));
if (fs.existsSync(path.join(project, installing ? 'ci-fail.txt' : 'build-fail.txt'))) process.exit(1);
if (installing) fs.writeFileSync(path.join(project, 'node_modules', 'installed.txt'), 'verified');
`);
  await writeFile(path.join(project, "npm.cmd"), `@"${process.execPath}" "%~dp0npm-shim.mjs" %*\r\n`, "ascii");
  await writeFile(path.join(project, "server.mjs"), `
import fs from 'node:fs'; import path from 'node:path';
const project = ${JSON.stringify(project)};
fs.appendFileSync(${JSON.stringify(events)}, 'node\\n');
fs.writeFileSync(path.join(project, 'node-started.txt'), JSON.stringify(process.argv.slice(2)));
while (fs.existsSync(path.join(project, 'node-hold.txt'))) await new Promise(resolve => setTimeout(resolve, 30));
`);
  const harness = `
function Get-ScheduledTask {
  param([string]$TaskName)
  [pscustomobject]@{ State = [IO.File]::ReadAllText(${psLiteral(receiverState)}).Trim();
    Actions = @([pscustomobject]@{ Execute = ${psLiteral(process.execPath)};
      Arguments = ${psLiteral(path.join(project, "community-server.mjs"))}; WorkingDirectory = ${psLiteral(project)} }) }
}
function Stop-ScheduledTask {
  param([string]$TaskName)
  [IO.File]::AppendAllText(${psLiteral(events)}, "stop\n")
  [IO.File]::WriteAllText(${psLiteral(receiverState)}, 'Ready')
}
function Start-ScheduledTask {
  param([string]$TaskName)
  [IO.File]::AppendAllText(${psLiteral(events)}, "start\n")
  [IO.File]::WriteAllText(${psLiteral(receiverState)}, 'Running')
}
function Invoke-RestMethod {
  param([string]$Uri, [int]$TimeoutSec)
  if ($Uri -eq 'http://127.0.0.1:${healthPort}/health') {
    if ([IO.File]::ReadAllText(${psLiteral(receiverState)}).Trim() -ne 'Running') { throw 'Receiver stopped' }
    return [pscustomobject]@{ status = 'ok'; application = 'hasunosora-community-receiver'; schemaVersion = 1 }
  }
  if (($Uri -eq 'http://127.0.0.1:8766/api/admin/identity') -and
      (Test-Path -LiteralPath ${psLiteral(path.join(project, "legacy-admin.txt"))})) {
    return [pscustomobject]@{ application = 'hasunosora-pilgrimage-admin'; schemaVersion = 1 }
  }
  throw 'No admin running'
}
& ${psLiteral(path.join(project, "update-community.ps1"))} -GitExe ${psLiteral(path.join(project, "git.cmd"))} -NpmExe ${psLiteral(path.join(project, "npm.cmd"))} -HealthPort ${healthPort}
`;
  const releaseGates = async () => {
    for (const name of ["ci-hold.txt", "build-hold.txt", "node-hold.txt", "ci-fail.txt", "build-fail.txt"]) {
      await rm(path.join(project, name), { force: true });
    }
    await rm(pending, { force: true });
  };
  const update = () => {
    const process = spawnPowerShell(harness, { cwd: directory });
    process.release = releaseGates;
    return process;
  };
  const launcher = (port) => {
    const process = spawnPowerShell(`& ${psLiteral(path.join(project, "start-admin-server.ps1"))} -Port ${port}`, {
      cwd: directory, env: { ...globalThis.process.env, PATH: `${project}${path.delimiter}${globalThis.process.env.PATH}` },
    });
    process.release = releaseGates;
    return process;
  };
  const seedDeployment = async () => {
    // Seed through the real updater, not a second copy of its hash algorithm.
    const process = update();
    const result = await process.done;
    assert.equal(result.code, 0, result.output);
    assert.equal((await readFile(deployed, "utf8")).trim(), initialCommit);
    assert.equal(await fileExists(pending), false);
    await writeFile(events, "");
    await rm(path.join(project, "ci-started.txt"));
  };
  let candidateCount = 0;
  const candidate = async (dependency = "2.0.0", version = "1.0.0") => {
    git("switch", "-c", `candidate-${++candidateCount}`);
    await manifests(dependency, version);
    git("add", "package.json", "package-lock.json");
    git("commit", "-m", "candidate");
    const commit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", commit);
    git("switch", "main");
    return commit;
  };
  const eventLines = async () => (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  const cleanup = () => rm(directory, { recursive: true, force: true });
  return { directory, project, state, healthPort, dependencyLock, pending, deployed, dependencyHash, receiverState, initialCommit,
    git, update, launcher, seedDeployment, candidate, eventLines, cleanup };
}
