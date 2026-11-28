import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

test("Pi CLI 以套件載入指令，尊重專案信任並保持 JSON stdout 可解析", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-handoff-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_HANDOFF_") && !key.startsWith("GIT_")));
  env.PI_CODING_AGENT_DIR = path.join(root, "pi-config");
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  await exec("git", ["init", "-q"], { cwd, env });
  const run = (...args) => {
    const child = exec(process.execPath, [cli, "--offline", "--no-session", "--no-tools", "-e", repo, ...args], { cwd, env, timeout: 10_000 });
    child.child.stdin.end(); // Pi 會先從非 TTY 的 stdin 讀到 EOF。
    return child;
  };

  const refused = await run("--no-approve", "-p", "/handoff-init agents");
  assert.match(refused.stderr, /尚未信任/);
  const handoff = path.join(cwd, "docs", "HANDOFF.md");
  await assert.rejects(readFile(handoff), { code: "ENOENT" });

  const initialized = await run("--approve", "-p", "/handoff-init agents");
  assert.match(initialized.stdout + initialized.stderr, /\/handoff-init 完成/);
  assert.match(await readFile(handoff, "utf8"), /## 下一步/);
  const ignored = await exec("git", ["check-ignore", ".pi/transcripts/example.jsonl", ".pi/handoff-history/example.md"], { cwd, env });
  assert.equal(ignored.stdout.trim().split(/\r?\n/).length, 2);

  const status = await run("--approve", "--mode", "json", "/handoff-status");
  const jsonLines = status.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(jsonLines.some((line) => line.type === "session"));
  assert.match(status.stderr, /下一步 1\.：第一個要做的具體動作/);
  assert.match(status.stderr, /異動[^\n]+：2 筆/);
});
