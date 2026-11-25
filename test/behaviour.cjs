/* pi-session-handoff 行為測試（jiti + mock context，不打模型）
 *
 * 用法：node test/behaviour.cjs
 * 可覆寫：PI_PKG_MODULES（Pi 的 node_modules）、PI_SMOKE_ROOT（暫存目錄）
 */
const path = require("node:path");
const fs = require("node:fs");
const cp = require("node:child_process");

const PI_HOME = process.env.PI_HOME || `${process.env.HOME}/.pi/agent`;
const PI_PKG = process.env.PI_PKG_MODULES || path.join(PI_HOME, "install/releases/1.6.0/node_modules");
const jiti = require(path.join(PI_PKG, "jiti"))(__filename, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": path.join(PI_PKG, "@earendil-works/pi-coding-agent/dist/index.js") },
});
const EXT = path.join(__dirname, "..", "extensions", "session-handoff.ts");
const ROOT = process.env.PI_SMOKE_ROOT || "/tmp/pi-bundle-smoke";
const REPO = path.join(ROOT, "proj");
const HANDOFF = path.join(REPO, "docs/HANDOFF.md");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " → " + extra : ""}`); }
}

function load() {
  const events = {};
  const commands = {};
  const pi = { on: (n, h) => { (events[n] ||= []).push(h); }, registerCommand: (n, o) => { commands[n] = o; } };
  const mod = jiti(EXT, { force: true });
  (mod.default ? mod.default : mod)(pi);
  return { events, commands, mod };
}

function mod2seed() {
  const m = jiti(EXT, { force: true });
  return m.seedHandoff();
}

function freshRepo() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  const run = (args) => cp.execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(REPO, "README.md"), "# demo\n");
  run(["add", "README.md"]);
  run(["commit", "-qm", "init"]);
}

function ctxFor(overrides = {}) {
  const notes = [];
  return {
    notes,
    ctx: {
      cwd: REPO, hasUI: false, mode: "print",
      ui: { notify: (m) => notes.push(String(m)), setStatus: () => {} },
      sessionManager: {
        getSessionFile: () => path.join(ROOT, "session.jsonl"),
        getBranch: () => [],
      },
      ...overrides,
    },
  };
}

fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, "session.jsonl"), '{"type":"session","version":3}\n');

(async () => {
  console.log("[0] 乾淨 repo＋無交接檔");
  freshRepo();
  let { events, commands, mod } = load();
  let { ctx, notes } = ctxFor();
  ok("註冊 5 事件", ["session_start", "before_agent_start", "agent_before_settle", "session_before_compact", "session_shutdown"].every((e) => events[e]), Object.keys(events).join(","));
  ok("註冊 4 指令", ["handoff-init", "handoff-status", "handoff-snapshot", "handoff-reload"].every((c) => commands[c]), Object.keys(commands).join(","));

  let r = await events["agent_before_settle"][0]({ entries: [] }, ctx);
  ok("髒檔為 0 → 不擋", !r);

  console.log("[1] /handoff-init 冪等");
  await commands["handoff-init"].handler("", ctx);
  ok("建立 docs/HANDOFF.md", fs.existsSync(HANDOFF));
  ok("建立 .pi/handoff.json", fs.existsSync(path.join(REPO, ".pi/handoff.json")));
  ok("補 .gitignore", fs.readFileSync(path.join(REPO, ".gitignore"), "utf8").includes(".pi/transcripts/"));
  ok("AGENTS.md 未主動改動", !fs.existsSync(path.join(REPO, "AGENTS.md")));
  const before = fs.readFileSync(HANDOFF, "utf8");
  await commands["handoff-init"].handler("", ctx);
  ok("第二次 init 不覆寫交接檔", fs.readFileSync(HANDOFF, "utf8") === before);
  const gi = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
  ok("第二次 init 不重複補 .gitignore", gi.split(".pi/transcripts/").length === 2);
  await commands["handoff-init"].handler("agents", ctx);
  const agents = fs.readFileSync(path.join(REPO, "AGENTS.md"), "utf8");
  ok("agents 參數寫入協定段", agents.includes("<!-- BEGIN pi-session-handoff -->"));
  await commands["handoff-init"].handler("agents", ctx);
  ok("協定段不重複附加", fs.readFileSync(path.join(REPO, "AGENTS.md"), "utf8").split("BEGIN pi-session-handoff").length === 2);

  console.log("[2] 注入");
  const run2 = load();
  const s2 = ctxFor();
  r = await run2.events["before_agent_start"][0]({ messageType: "user", prompt: "hi" }, s2.ctx);
  ok("第一則提示注入交接內容", r && r.message.content.includes("上次 session 交接"));
  r = await run2.events["before_agent_start"][0]({ messageType: "user", prompt: "hi" }, s2.ctx);
  ok("同 session 第二次不注入", !r);

  const run3 = load();
  const fresh = new Date(Date.now() + 5000).toISOString();
  const s3 = ctxFor({ sessionManager: { getSessionFile: () => path.join(ROOT, "session.jsonl"), getBranch: () => [{ type: "custom_message", customType: "session-handoff-context", timestamp: fresh }] } });
  r = await run3.events["before_agent_start"][0]({ messageType: "user", prompt: "hi" }, s3.ctx);
  ok("resume/reload 已有注入 → 跳過", !r);

  const run4 = load();
  const s4 = ctxFor();
  r = await run4.events["before_agent_start"][0]({ messageType: "custom", message: {} }, s4.ctx);
  ok("messageType=custom → 不注入", !r);

  console.log("[3] 設定覆蓋（.pi/handoff.json）");
  fs.mkdirSync(path.join(REPO, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".pi/handoff.json"), JSON.stringify({ staleMinutes: 1, nagOnSettle: false, verifyCommand: "npm test" }, null, 2));
  const run5 = load();
  const s5 = ctxFor({ hasUI: true });
  await run5.commands["handoff-status"].handler("", s5.ctx);
  ok("status 讀到 verifyCommand 與設定來源", s5.notes.join("\n").includes("npm test") && s5.notes.join("\n").includes("handoff.json"), s5.notes.join("|"));

  fs.utimesSync(HANDOFF, new Date(Date.now() - 5 * 60 * 1000), new Date(Date.now() - 5 * 60 * 1000));
  fs.writeFileSync(path.join(REPO, "dirty.txt"), "x");
  r = await run5.events["agent_before_settle"][0]({ entries: [] }, s5.ctx);
  ok("nagOnSettle=false → 只印提醒不回傳", !r && s5.notes.some((n) => n.includes("交接檢查")), JSON.stringify(s5.notes).slice(0, 120));

  console.log("[4] 預設 nagOnSettle=true → 擋一次");
  fs.rmSync(path.join(REPO, ".pi/handoff.json"));
  const veryOld = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(HANDOFF, veryOld, veryOld);
  const run6 = load();
  const s6 = ctxFor();
  r = await run6.events["agent_before_settle"][0]({ entries: [] }, s6.ctx);
  ok("逾時＋髒檔 → 要求續跑一次", r && r.continue === true && r.entries.length === 1);
  const r7 = await run6.events["agent_before_settle"][0]({ entries: [] }, s6.ctx);
  ok("同 session 只擋一次", !r7);

  console.log("[4b] 只有 .pi/、.agents/、交接檔本身髒 → 不擋");
  freshRepo();
  fs.mkdirSync(path.join(REPO, "docs"), { recursive: true });
  fs.writeFileSync(HANDOFF, mod2seed(), { mode: 0o644 });
  fs.utimesSync(HANDOFF, veryOld, veryOld);
  fs.mkdirSync(path.join(REPO, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(REPO, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".pi/x.json"), "{}");
  fs.writeFileSync(path.join(REPO, ".agents/y.md"), "y");
  const run7b = load();
  const s7b = ctxFor();
  r = await run7b.events["agent_before_settle"][0]({ entries: [] }, s7b.ctx);
  ok("本機產物不觸發收尾提醒", !r);

  console.log("[5] 髒檔排除與非 git repo");
  fs.rmSync(path.join(REPO, "dirty.txt"), { force: true });
  freshRepoCommitHandoff();
  const run8 = load();
  const s8 = ctxFor({ cwd: path.join(ROOT, "notgit") });
  fs.mkdirSync(path.join(ROOT, "notgit"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "notgit/dirty"), "x");
  r = await run8.events["agent_before_settle"][0]({ entries: [] }, s8.ctx);
  ok("非 git repo → 不檢查", !r);

  console.log("[6] 快照");
  const clean = load();
  const sc = ctxFor();
  await clean.events["session_before_compact"][0]({ reason: "manual" }, sc.ctx);
  await clean.events["session_shutdown"][0]({ reason: "quit" }, sc.ctx);
  await clean.commands["handoff-snapshot"].handler("", sc.ctx);
  const t = fs.readdirSync(path.join(REPO, ".pi/transcripts"));
  const h = fs.readdirSync(path.join(REPO, ".pi/handoff-history"));
  ok("transcripts 3 份", t.length === 3, t.join(","));
  ok("handoff-history 3 份", h.length === 3, h.join(","));

  console.log(`\n結果：${pass} 項通過，${fail} 項失敗`);
  process.exit(fail ? 1 : 0);

  function freshRepoCommitHandoff() {
    // 交接檔 fresh 且無髒檔：把交接檔加入 commit，確認不觸發提醒
    const run = (args) => cp.execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
    run(["add", "-A"]);
    run(["commit", "-qm", "handoff init"]);
  }
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
