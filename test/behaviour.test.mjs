import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/session-handoff.ts";

const exec = promisify(execFile);
const configPath = path.join(CONFIG_DIR_NAME, "handoff.json");
const handoffPath = "docs/HANDOFF.md";
const transcripts = path.join(CONFIG_DIR_NAME, "transcripts");
const history = path.join(CONFIG_DIR_NAME, "handoff-history");
const handoffEnv = () => Object.entries(process.env).filter(([key]) => key.startsWith("PI_HANDOFF_"));
let savedEnv;
beforeEach(() => {
  savedEnv = handoffEnv();
  for (const [key] of savedEnv) delete process.env[key];
});
afterEach(() => {
  for (const [key] of handoffEnv()) delete process.env[key];
  for (const [key, value] of savedEnv) process.env[key] = value;
});

async function fixture(t, { git = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-handoff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const sessionFile = path.join(root, "session.jsonl");
  await mkdir(cwd);
  await writeFile(sessionFile, '{"type":"session","version":3}\n', { mode: 0o644 });
  const commands = new Map();
  const events = [];
  const messages = [];
  const notes = [];
  const ctx = {
    cwd, hasUI: true, mode: "tui",
    ui: { notify: (text, level) => notes.push({ text, level }) },
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => sessionFile },
  };
  let gitCalls = 0;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  extension({
    on: (name) => events.push(name),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: () => assert.fail("不該觸發模型"),
    exec: async (command, args, options) => {
      gitCalls++;
      try {
        return { ...(await exec(command, args, { ...options, env })), code: 0 };
      } catch (error) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: 1 };
      }
    },
  });
  async function put(file, text) {
    const target = path.join(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const runGit = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  if (git) runGit("init", "-q");
  return {
    root, cwd, ctx, sessionFile, commands, events, messages, notes, put, runGit,
    read: (file) => readFile(path.join(cwd, file), "utf8"),
    list: (dir) => readdir(path.join(cwd, dir)),
    config: (data, file = configPath) => put(file, JSON.stringify(data)),
    gitCalls: () => gitCalls,
    async run(name, args = "", overrides = {}) {
      const previous = notes.length;
      await commands.get(`handoff-${name}`).handler(args, { ...ctx, ...overrides });
      return notes.slice(previous).at(-1)?.text ?? "";
    },
  };
}

test("只註冊手動指令，舊自動設定不觸發讀取、交接或壓縮", async (t) => {
  process.env.PI_HANDOFF_AUTO_COMPACT = "true";
  const p = await fixture(t);
  await p.config({ autoHandoffCompact: true, snapshotOnShutdown: true });
  assert.deepEqual([...p.commands.keys()].sort(), ["init", "read", "reload", "snapshot", "status"].map((v) => `handoff-${v}`));
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.messages, []);
  await assert.rejects(p.read(handoffPath), { code: "ENOENT" });
  await assert.rejects(p.list(transcripts), { code: "ENOENT" });
});

test("未信任專案不讀寫檔案、不查 Git，也不注入交接", async (t) => {
  const p = await fixture(t);
  await p.put(handoffPath, "敏感交接內容");
  for (const name of ["init", "status", "read", "snapshot", "reload"]) {
    assert.match(await p.run(name, "", { isProjectTrusted: () => false }), /尚未信任/);
  }
  assert.equal(p.gitCalls(), 0);
  assert.deepEqual(p.messages, []);
  await assert.rejects(p.read(configPath), { code: "ENOENT" });
  await assert.rejects(p.list(transcripts), { code: "ENOENT" });
});

test("初始化可重跑、只接受確切參數，force 不重設設定", async (t) => {
  const p = await fixture(t, { git: true });
  const custom = "notes/交接.md";
  const ignore = `# 既有設定\r\n# pi-session-handoff（本機產物，勿入版控）\r\n/${transcripts}/\r\n!/${transcripts}/\r\n`;
  await p.put(".gitignore", ignore);
  await p.config({ handoffPath: custom, verifyCommand: "npm test" });
  assert.match(await p.run("init", "nottrue"), /用法/);
  await assert.rejects(p.read(custom), { code: "ENOENT" });
  await p.run("init");
  assert.match(await p.read(custom), /## 下一步/);
  await assert.rejects(p.read("AGENTS.md"), { code: "ENOENT" });
  const gitignore = await p.read(".gitignore");
  assert.ok(gitignore.startsWith(ignore));
  assert.ok(gitignore.includes(`/${history}/\r\n`));
  assert.match(p.runGit("check-ignore", `${transcripts}/x.jsonl`), /x\.jsonl/);
  await p.put(custom, "既有交接");
  await p.run("init", "--agents");
  await p.run("init", "agents");
  assert.equal(await p.read(custom), "既有交接");
  assert.equal(await p.read(".gitignore"), gitignore);
  const agents = await p.read("AGENTS.md");
  assert.equal(agents.match(/BEGIN pi-session-handoff/g).length, 1);
  assert.match(agents, /使用者要求時以 `\/handoff-read`/);
  await p.run("init", "-f");
  assert.match(await p.read(custom), /## 下一步/);
  assert.deepEqual(JSON.parse(await p.read(configPath)), { handoffPath: custom, verifyCommand: "npm test" });
});

test("初始化的 force 不改寫專案外路徑或設定檔衝突目標", async (t) => {
  const p = await fixture(t);
  await p.config({ handoffPath: p.sessionFile });
  const original = await readFile(p.sessionFile, "utf8");
  assert.match(await p.run("init", "force"), /不在專案內/);
  assert.equal(await readFile(p.sessionFile, "utf8"), original);
  await symlink(p.root, path.join(p.cwd, "outside"), "dir");
  await p.config({ handoffPath: "outside/session.jsonl" });
  assert.match(await p.run("init", "force"), /不在專案內/);
  assert.equal(await readFile(p.sessionFile, "utf8"), original);
  await p.config({ handoffPath: configPath });
  assert.match(await p.run("init", "force"), /專案設定檔衝突/);
  assert.deepEqual(JSON.parse(await p.read(configPath)), { handoffPath: configPath });
  await p.config({ handoffPath: ".git/config" });
  assert.match(await p.run("init", "force"), /位於 \.git/);
  await assert.rejects(p.read(".git/config"), { code: "ENOENT" });
});

test("設定逐欄合併，檔案與環境變數修改不需手動清快取", async (t) => {
  const p = await fixture(t);
  await p.put("from-local.md", "本地設定的交接");
  await p.put("root.md", "根目錄設定的交接");
  await p.config({ handoffPath: "from-local.md", verifyCommand: "npm test", staleMinutes: "12.5" });
  await p.config({ handoffPath: "root.md", staleMinutes: " " }, "handoff.json");
  await utimes(path.join(p.cwd, "root.md"), 1, 1);
  assert.match(await p.run("status"), /過舊（門檻 12.5 分鐘）/);
  assert.match(await p.run("status"), /設定來源：預設值 → .+handoff.json → handoff.json/);
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /根目錄設定的交接/);
  assert.equal(p.messages.at(-1).options.deliverAs, "nextTurn");
  process.env.PI_HANDOFF_PATH = "from-local.md";
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /本地設定的交接/);
  process.env.PI_HANDOFF_VERIFY_COMMAND = "";
  assert.match(await p.run("status"), /驗證指令：（未設定）/);
  delete process.env.PI_HANDOFF_PATH;
  delete process.env.PI_HANDOFF_VERIFY_COMMAND;
  await p.put("handoff.json", "null");
  assert.match(await p.run("reload"), /handoff.json 無法讀取或解析/);
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /本地設定的交接/);
  await p.config({ handoffPath: "root.md" }, "handoff.json");
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /根目錄設定的交接/);
  assert.match(await p.run("status"), /驗證指令：npm test/);
});

test("未提交異動以 NUL 拆分、計算重新命名一次，且精確排除交接檔", async (t) => {
  const p = await fixture(t, { git: true });
  const handoff = "docs/交接 -> 下次\n (草稿).md";
  await p.config({ handoffPath: handoff, ignorePrefixes: ["./notes/"] });
  await p.put(handoff, "不能被算入變更");
  await p.put(`${handoff}.bak`, "這個要算");
  await p.put("notes/ignored.txt", "忽略");
  await p.put(".agents/來源.txt", "準備重新命名");
  p.runGit("add", "-f", "--", ".agents/來源.txt");
  p.runGit("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  p.runGit("mv", "--", ".agents/來源.txt", "新 名稱 -> beta.txt");
  assert.match(p.runGit("status", "--porcelain=v1", "-z", "--renames"), /R  新 名稱 -> beta\.txt\0\.agents\/來源\.txt\0/);
  assert.match(await p.run("status"), /異動[^\n]+：2 筆/);
});

test("Git 子目錄使用 repo 根相對路徑，非 Git 不回報成 0 筆", async (t) => {
  const p = await fixture(t, { git: true });
  await p.put("README.md", "算入整個 Git 儲存庫");
  await p.put(`nested/${handoffPath}`, "排除子目錄的交接檔");
  await p.put(`nested/${configPath}`, "{}");
  assert.match(await p.run("status", "", { cwd: path.join(p.cwd, "nested") }), /異動[^\n]+：1 筆/);
  await mkdir(path.join(p.root, "not-git"));
  assert.match(await p.run("status", "", { cwd: path.join(p.root, "not-git") }), /未檢查（Git 狀態無法取得）/);
});

test("狀態只從下一步段落取條目，不越界到決策段落", async (t) => {
  const p = await fixture(t);
  await p.put(handoffPath, "## 下一步（依優先序）\r\n\r\n無\r\n\r\n## 決策\r\n1. 不該出現\r\n");
  assert.match(await p.run("status"), /下一步：（未找到）/);
  await p.put(handoffPath, "## Next steps\r\n\r\n1) 第一件事\r\n2. 第二件事\r\n");
  assert.match(await p.run("status"), /下一步 1.：第一件事/);
});

test("手動讀取處理遺失、空檔、0 字元、截斷與非一般檔案", async (t) => {
  const p = await fixture(t);
  assert.match(await p.run("read"), /找不到交接檔/);
  await p.put(handoffPath, "  \n");
  assert.match(await p.run("read"), /為空/);
  const content = "中文😀後面的內容";
  await p.put(handoffPath, content);
  await p.config({ maxInjectChars: 0 });
  assert.match(await p.run("read"), /未提供交接內容/);
  assert.deepEqual(p.messages, []);
  await p.config({ maxInjectChars: 3 });
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /\n中文\n…（已截斷/);
  assert.doesNotMatch(p.messages.at(-1).message.content, /[\uD800-\uDFFF]|後面的內容/u);
  assert.equal(await p.read(handoffPath), content);
  await p.put(handoffPath, `${"a".repeat(4095)}😀${"z".repeat(100_000)}`);
  await p.config({ maxInjectChars: 4097 });
  await p.run("read");
  assert.match(p.messages.at(-1).message.content, /a😀\n…（已截斷/);
  assert.doesNotMatch(p.messages.at(-1).message.content, /zz/);
  await p.config({ handoffPath: "docs" });
  assert.match(await p.run("read"), /不是一般檔案/);
});

test("連續的手動快照檔名不衝突，保留限制不刪不相干檔案", async (t) => {
  const p = await fixture(t);
  const fixed = new Date("2026-11-28T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: fixed });
  await p.config({ handoffPath: "custom.md", keepSnapshots: 2 });
  await p.put("custom.md", "快照 A");
  await p.put(`${transcripts}/README.txt`, "請勿刪除");
  const legacy = `${transcripts}/20260101-120000-manual.jsonl`;
  await p.put(legacy, "舊版命名");
  await utimes(path.join(p.cwd, legacy), 1, 1);
  await p.put(`${history}/20260101-120000-manual.jsonl`, "不同種類不刪");
  const link = `${transcripts}/20260102-120000-manual.jsonl`;
  await symlink(p.sessionFile, path.join(p.cwd, link));
  assert.match(await p.run("snapshot"), /已備份 transcript/);
  await p.put("custom.md", "快照 B");
  assert.match(await p.run("snapshot"), /已備份 交接檔/);
  const snapshots = (await p.list(history)).filter((file) => file.endsWith(".md"));
  assert.equal(snapshots.length, 2);
  assert.deepEqual((await Promise.all(snapshots.map((file) => p.read(path.join(history, file))))).sort(), ["快照 A", "快照 B"]);
  assert.ok(snapshots.every((name) => name.startsWith("20261128-120000000-")));
  const saved = (await p.list(transcripts)).sort();
  assert.deepEqual(saved.filter((file) => file.startsWith("20261128-")), snapshots.map((name) => name.replace(/\.md$/, ".jsonl")).sort());
  assert.ok(saved.includes("README.txt"));
  assert.ok(saved.includes(path.basename(link)));
  assert.ok(!saved.includes(path.basename(legacy)));
  assert.ok(!saved.some((file) => file.endsWith(".tmp")));
  assert.equal((await stat(path.join(p.cwd, history, snapshots[0]))).mode & 0o077, 0);
  await p.config({ keepSnapshots: 0 });
  assert.match(await p.run("snapshot"), /未建立快照；既有快照不變/);
  assert.deepEqual((await p.list(transcripts)).sort(), saved);
});

test("快照能報告單一備份失敗及其餘成功，不把無來源當成完成", async (t) => {
  const p = await fixture(t);
  assert.match(await p.run("snapshot", "", { sessionManager: { getSessionFile: () => undefined } }), /未備份 transcript：來源不存在/);
  await p.put(handoffPath, "交接仍會備份");
  await p.put(transcripts, "是檔案，不是資料夾");
  const result = await p.run("snapshot");
  assert.match(result, /transcript 快照作業失敗/);
  assert.match(result, /已備份 交接檔/);
});
