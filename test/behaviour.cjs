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
  const messages = [];
  const pi = { on: (n, h) => { (events[n] ||= []).push(h); }, registerCommand: (n, o) => { commands[n] = o; }, sendMessage: (message, options) => messages.push({ message, options }) };
  const mod = jiti(EXT, { force: true });
  (mod.default ? mod.default : mod)(pi);
  return { events, commands, messages, mod };
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
  ok("不註冊任何 session hook", Object.keys(events).length === 0, Object.keys(events).join(","));
  ok("手動指令可用", ["handoff-init", "handoff-status", "handoff-read", "handoff-snapshot", "handoff-reload"].every((c) => commands[c]), Object.keys(commands).join(","));

  console.log("[0a] 高用量不自動交接或壓縮");
  const automaticActions = [];
  const autoEvents = {};
  const autoPi = {
    on: (name, handler) => { (autoEvents[name] ||= []).push(handler); },
    registerCommand: () => {},
    getSettings: () => ({ compaction: { enabled: true } }),
    sendMessage: (...args) => automaticActions.push(["message", ...args]),
    sendUserMessage: (...args) => automaticActions.push(["userMessage", ...args]),
  };
  (mod.default ? mod.default : mod)(autoPi);
  const autoCtx = ctxFor({
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
    compact: () => automaticActions.push(["compact"]),
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => path.join(ROOT, "session.jsonl"),
      getBranch: () => [],
      getLeafId: () => null,
    },
  }).ctx;
  fs.mkdirSync(path.join(REPO, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".pi/handoff.json"), JSON.stringify({ autoHandoffCompact: true }));
  const oldAutoEnv = process.env.PI_HANDOFF_AUTO_COMPACT;
  process.env.PI_HANDOFF_AUTO_COMPACT = "true";
  for (const handler of autoEvents.session_start || []) await handler({}, autoCtx);
  for (const handler of autoEvents.turn_end || []) {
    await handler({ outcome: "completed", message: { role: "assistant", stopReason: "stop" } }, autoCtx);
  }
  for (const handler of autoEvents.agent_settled || []) await handler({ aborted: false }, autoCtx);
  if (oldAutoEnv === undefined) delete process.env.PI_HANDOFF_AUTO_COMPACT;
  else process.env.PI_HANDOFF_AUTO_COMPACT = oldAutoEnv;
  ok("高用量與舊啟用設定不觸發交接或壓縮", automaticActions.length === 0 && !fs.existsSync(HANDOFF));
  fs.rmSync(path.join(REPO, ".pi"), { recursive: true, force: true });


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
  const config = JSON.parse(fs.readFileSync(path.join(REPO, ".pi/handoff.json"), "utf8"));
  ok("新設定不含自動事件選項", !("nagMode" in config) && !("injectOnStart" in config) && !("snapshotOnCompact" in config) && !("snapshotOnShutdown" in config));
  ok("產生的協定要求手動讀取", agents.includes("/handoff-read") && !agents.includes("hook"));

  console.log("[2] 手動讀取交接");
  const run2 = load();
  await run2.commands["handoff-read"].handler("", ctx);
  ok("手動讀取將交接內容提供給下一輪", run2.messages.length === 1 && run2.messages[0].message.content.includes(before.trim()) && run2.messages[0].options.deliverAs === "nextTurn");
  ok("手動讀取不改寫交接檔", fs.readFileSync(HANDOFF, "utf8") === before);
  const missing = load();
  const missingCtx = ctxFor({ cwd: path.join(ROOT, "missing"), hasUI: true });
  await missing.commands["handoff-read"].handler("", missingCtx.ctx);
  ok("交接檔不存在時回報且不注入", missing.messages.length === 0 && missingCtx.notes.some((n) => n.includes("找不到交接檔")));

  console.log("[3] 設定覆蓋（.pi/handoff.json）");
  fs.mkdirSync(path.join(REPO, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".pi/handoff.json"), JSON.stringify({ staleMinutes: 1, nagOnSettle: false, verifyCommand: "npm test" }, null, 2));
  const run5 = load();
  const s5 = ctxFor({ hasUI: true });
  await run5.commands["handoff-status"].handler("", s5.ctx);
  ok("status 讀到 verifyCommand 與設定來源", s5.notes.join("\n").includes("npm test") && s5.notes.join("\n").includes("handoff.json"), s5.notes.join("|"));
  const custom = path.join(REPO, "custom.md");
  fs.writeFileSync(custom, "自訂交接內容");
  fs.writeFileSync(path.join(REPO, ".pi/handoff.json"), JSON.stringify({ handoffPath: "custom.md" }));
  await run5.commands["handoff-reload"].handler("", s5.ctx);
  await run5.commands["handoff-read"].handler("", s5.ctx);
  ok("重載後手動讀取設定的交接檔", run5.messages.length === 1 && run5.messages[0].message.content.includes("自訂交接內容"));
  fs.writeFileSync(custom, "");
  await run5.commands["handoff-read"].handler("", s5.ctx);
  ok("空交接檔不注入", run5.messages.length === 1 && s5.notes.some((n) => n.includes("為空或無法讀取")));
  fs.writeFileSync(custom, "快照內容");


  console.log("[6] 快照");
  const clean = load();
  const sc = ctxFor();
  ok("手動快照前沒有備份", !fs.existsSync(path.join(REPO, ".pi/transcripts")) && !fs.existsSync(path.join(REPO, ".pi/handoff-history")));
  await clean.commands["handoff-snapshot"].handler("", sc.ctx);
  const t = fs.readdirSync(path.join(REPO, ".pi/transcripts"));
  const h = fs.readdirSync(path.join(REPO, ".pi/handoff-history"));
  ok("手動快照備份 transcript", t.length === 1, t.join(","));
  ok("手動快照備份交接檔", h.length === 1, h.join(","));
  ok("手動快照使用設定的交接檔", fs.readFileSync(path.join(REPO, ".pi/handoff-history", h[0]), "utf8") === "快照內容");

  console.log(`\n結果：${pass} 項通過，${fail} 項失敗`);
  process.exit(fail ? 1 : 0);

})().catch((e) => { console.error("FAIL", e); process.exit(1); });
