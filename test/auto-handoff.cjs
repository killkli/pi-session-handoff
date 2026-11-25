/* Run with node --test test/auto-handoff.cjs (requires Pi 1.6.0's jiti). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const piHome = process.env.PI_HOME || path.join(os.homedir(), ".pi/agent");
const piModules = process.env.PI_PKG_MODULES || path.join(piHome, "install/releases/1.6.0/node_modules");
const jiti = require(path.join(piModules, "jiti"))(__filename, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": path.join(piModules, "@earendil-works/pi-coding-agent/dist/index.js") },
});
const extension = path.join(__dirname, "../extensions/session-handoff.ts");
const original = "舊交接內容：不得在成功驗證前覆寫\n";
const handoff = `# 交接（HANDOFF）

## 目標
完成工作。
## 本次完成
- 已完成的副作用。
## 進行中（未完成）
- 等待後續步驟。
## 下一步（依優先序）
1. 從中斷處繼續，不重複已完成的副作用。
## 已決定的事與理由
- 使用原 session，以保留上下文。
## 死路（試過不行的）
- 無。
## 待我確認
- 無。
## 驗證狀態
- 未跑。
`;

// This fixture implements the public Pi event/context surface. A triggerTurn sent
// while agent_settled is being dispatched is delivered only after it returns.
function fixture(t, { bundle = {}, settings = {}, hasUI = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "docs/HANDOFF.md");
  const sessionFile = path.join(root, "session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(file, original);
  fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n');
  fs.writeFileSync(path.join(root, ".pi/handoff.json"), JSON.stringify({ nagMode: "off", ...bundle }));

  const events = new Map(), actions = [], notifications = [], branch = [];
  const state = { idle: true, pending: false, session: "session-1", usage: { tokens: 499, contextWindow: 1000, percent: 49.9 } };
  let id = 0;
  function append(entry) {
    const parentId = branch.at(-1)?.id ?? null;
    const complete = { id: String(++id), parentId, timestamp: new Date().toISOString(), ...entry };
    branch.push(complete);
    return complete;
  }
  const manager = {
    getSessionId: () => state.session,
    getSessionFile: () => sessionFile,
    getBranch: () => branch.slice(),
    getEntries: () => branch.slice(),
    getLeafId: () => branch.at(-1)?.id ?? null,
    getLeafEntry: () => branch.at(-1),
    getEntry: (entryId) => branch.find((entry) => entry.id === entryId),
  };
  const ctx = {
    cwd: root, hasUI, mode: hasUI ? "tui" : "print", sessionManager: manager,
    ui: { notify: (message, level) => notifications.push({ message: String(message), level }), setStatus: () => {} },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    getContextUsage: () => state.usage,
    model: { contextWindow: 1000 },
    signal: undefined,
    abort: () => { actions.push({ type: "abort" }); },
    compact: (options = {}) => { actions.push({ type: "compact", options }); },
  };
  const pi = {
    on: (name, handler) => { if (!events.has(name)) events.set(name, []); events.get(name).push(handler); },
    registerCommand: () => {},
    getSettings: () => settings,
    sendMessage: (message, options = {}) => { actions.push({ type: "message", message, options }); },
    sendUserMessage: (message, options = {}) => { actions.push({ type: "userMessage", message, options }); },
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
  };
  const mod = jiti(extension, { force: true });
  (mod.default || mod)(pi);
  async function emit(name, event = {}) {
    for (const handler of events.get(name) || []) await handler({ type: name, ...event }, ctx);
  }
  function userMessage(text = "請繼續任務") {
    append({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
  }
  async function startUser(text = "請繼續任務") {
    state.idle = false;
    await emit("before_agent_start", { messageType: "user", prompt: text, systemPrompt: "", systemPromptOptions: {} });
    userMessage(text);
    await emit("agent_start");
  }
  async function turn({ tool = false, outcome = "completed" } = {}) {
    state.idle = false;
    const message = {
      role: "assistant", content: tool ? [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }] : [{ type: "text", text: "工作完成" }],
      api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: tool ? "toolUse" : outcome === "aborted" ? "aborted" : outcome === "error" ? "error" : "stop", timestamp: Date.now(),
    };
    const entry = append({ type: "message", message });
    const toolResults = tool ? [{ role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() }] : [];
    const toolResultEntryIds = toolResults.map((result) => append({ type: "message", message: result }).id);
    await emit("turn_end", { turnIndex: id, message, toolResults, messageEntryId: entry.id, toolResultEntryIds, entries: [], continue: false, context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }, outcome });
  }
  async function settled(aborted = false) {
    state.idle = true;
    await emit("agent_settled", { aborted });
  }
  function messagesSince(index = 0) { return actions.slice(index).filter((action) => action.type === "message" || action.type === "userMessage"); }
  function compactSince(index = 0) { return actions.slice(index).find((action) => action.type === "compact"); }
  async function startSentMessage(action) {
    assert.equal(action.type, "message", "handoff/continuation must be a custom message");
    assert.equal(action.options.triggerTurn, true);
    // Pi runs before_agent_start before appending the deferred starting message.
    state.idle = false;
    await emit("before_agent_start", { messageType: "custom", message: { role: "custom", ...action.message, timestamp: Date.now() }, systemPrompt: "", systemPromptOptions: {} });
    append({ type: "custom_message", ...action.message });
    await emit("agent_start");
  }
  function tempFile(action) {
    const content = typeof action.message.content === "string" ? action.message.content : action.message.content.map((c) => c.text || "").join("\n");
    // The path is machine-readable; the remainder of the model instruction is not an API.
    const match = content.match(/暫存檔：("(?:[^"\\]|\\.)*")/);
    assert.ok(match, "handoff request must provide its temporary file path");
    const temp = JSON.parse(match[1]);
    assert.ok(path.isAbsolute(temp));
    assert.notEqual(temp, file, "model must never write directly over the previous handoff");
    return temp;
  }
  async function requestHandoff() {
    await startUser();
    state.usage = { tokens: 500, contextWindow: 1000, percent: 50 };
    await turn({ tool: true });
    assert.deepEqual(messagesSince(), [], "turn_end must not interrupt the active tool turn");
    assert.equal(compactSince(), undefined, "turn_end must not compact");
    await turn();
    assert.deepEqual(messagesSince(), [], "the interrupted task must finish naturally before handoff");
    assert.equal(compactSince(), undefined);
    await settled();
    const request = messagesSince().find((action) => action.options?.triggerTurn);
    assert.ok(request, "settled high-usage session should request a handoff turn");
    assert.equal(fs.readFileSync(file, "utf8"), original);
    await startSentMessage(request);
    return tempFile(request);
  }
  async function modelFinished(temp, content = handoff) {
    if (content !== null) {
      fs.mkdirSync(path.dirname(temp), { recursive: true });
      fs.writeFileSync(temp, content);
    }
    await turn();
    await settled();
  }
  async function completeCompact(compact, beforeCallback = () => {}) {
    await emit("session_before_compact", { reason: "manual", willRetry: false, preparation: {}, branchEntries: branch.slice(), signal: new AbortController().signal });
    const result = { summary: "摘要", firstKeptEntryId: "1", tokensBefore: 500 };
    const compactionEntry = append({ type: "compaction", ...result });
    await emit("session_compact", { reason: "manual", willRetry: false, fromExtension: false, compactionEntry });
    beforeCallback();
    compact.options.onComplete(result);
  }
  return { root, file, ctx, state, actions, notifications, append, emit, turn, settled, userMessage, startUser, messagesSince, compactSince, startSentMessage, requestHandoff, modelFinished, completeCompact };
}

test("threshold is checked during turns, but an active tool turn is never interrupted", async (t) => {
  for (const usage of [
    { tokens: 490, contextWindow: 1000, percent: 49 },
    undefined,
    { tokens: null, contextWindow: 1000, percent: null },
    { tokens: 900, contextWindow: 0, percent: null },
  ]) {
    const f = fixture(t);
    await f.startUser();
    f.state.usage = usage;
    await f.turn({ tool: true });
    await f.turn();
    await f.settled();
    assert.deepEqual(f.messagesSince(), [], "below threshold and unknown usage must not start a handoff");
    assert.equal(f.compactSince(), undefined);
  }
  const f = fixture(t);
  await f.startUser();
  f.state.usage = { tokens: 490, contextWindow: 1000, percent: 49 };
  await f.turn({ tool: true });
  f.state.usage = { tokens: 500, contextWindow: 1000, percent: 50 };
  await f.turn({ tool: true });
  assert.deepEqual(f.messagesSince(), []);
  assert.equal(f.compactSince(), undefined);
  await f.turn();
  assert.deepEqual(f.messagesSince(), [], "the original run may finish additional turns");
  assert.equal(f.compactSince(), undefined);
  await f.settled();
  assert.ok(f.messagesSince().some((action) => action.options?.triggerTurn));
});

test("valid handoff is installed before compact, then resumes in the same session", async (t) => {
  const f = fixture(t);
  const temp = await f.requestHandoff();
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  const beforeCompaction = f.actions.length;
  await f.modelFinished(temp);
  const compact = f.compactSince(beforeCompaction);
  assert.ok(compact, "compact only after the handoff turn settles");
  assert.equal(fs.readFileSync(f.file, "utf8"), handoff);
  assert.equal(fs.existsSync(temp), false, "atomic installation consumes the temporary file");
  assert.deepEqual(f.messagesSince(beforeCompaction), [], "resume must wait for the compact callback");
  const beforeResume = f.actions.length;
  await f.completeCompact(compact);
  const resume = f.messagesSince(beforeResume).find((action) => action.options?.triggerTurn);
  assert.ok(resume, "successful compact starts continuation");
  assert.equal(resume.options.deliverAs, "followUp");
  assert.equal(f.state.session, "session-1");
  await f.startSentMessage(resume);
  // Even if usage remains high, the handoff/continuation must not recursively start another cycle.
  const afterResume = f.actions.length;
  await f.turn();
  await f.settled();
  assert.deepEqual(f.messagesSince(afterResume), []);
  assert.equal(f.compactSince(afterResume), undefined);
});

test("native compaction supersedes a pending threshold and preserves snapshots", async (t) => {
  const f = fixture(t);
  await f.startUser();
  f.state.usage = { tokens: 800, contextWindow: 1000, percent: 80 };
  await f.turn({ tool: true });
  assert.deepEqual(f.messagesSince(), []);
  await f.emit("session_before_compact", { reason: "threshold", willRetry: false, preparation: {}, branchEntries: [], signal: new AbortController().signal });
  f.append({ type: "compaction", summary: "native summary", firstKeptEntryId: "1", tokensBefore: 800 });
  f.state.usage = { tokens: null, contextWindow: 1000, percent: null };
  await f.emit("session_compact", { reason: "threshold", willRetry: false, fromExtension: false, compactionEntry: f.ctx.sessionManager.getLeafEntry() });
  await f.settled();
  assert.deepEqual(f.messagesSince(), [], "a native compaction must not be followed by a stale handoff");
  assert.equal(f.compactSince(), undefined);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.ok(fs.readdirSync(path.join(f.root, ".pi/transcripts")).length > 0, "normal pre-compaction snapshot remains enabled");
  assert.ok(fs.readdirSync(path.join(f.root, ".pi/handoff-history")).length > 0);
});

test("the same handoff and compact sequence works without an interactive UI", async (t) => {
  const f = fixture(t, { hasUI: false });
  const temp = await f.requestHandoff();
  await f.modelFinished(temp);
  const compact = f.compactSince();
  assert.ok(compact);
  assert.equal(fs.readFileSync(f.file, "utf8"), handoff);
  const before = f.actions.length;
  await f.completeCompact(compact);
  assert.ok(f.messagesSince(before).some((action) => action.type === "message" && action.options?.deliverAs === "followUp"));
});

test("aborting the original high-usage task does not launch a handoff", async (t) => {
  const f = fixture(t);
  await f.startUser();
  f.state.usage = { tokens: 600, contextWindow: 1000, percent: 60 };
  await f.turn({ outcome: "aborted" });
  await f.settled(true);
  await f.settled();
  assert.deepEqual(f.messagesSince(), []);
  assert.equal(f.compactSince(), undefined);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
});

test("bundle and Pi settings can independently disable automatic handoff", async (t) => {
  for (const options of [{ bundle: { autoHandoffCompact: false } }, { settings: { compaction: { enabled: false } } }]) {
    const f = fixture(t, options);
    await f.startUser();
    f.state.usage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await f.turn();
    await f.settled();
    assert.deepEqual(f.messagesSince(), []);
    assert.equal(f.compactSince(), undefined);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
  }
});

test("missing, malformed or oversized handoff never replaces the old file or compacts", async (t) => {
  for (const content of [null, "# 不完整\n## 目標\n內容\n", handoff + "多餘行\n".repeat(81)]) {
    const f = fixture(t);
    const temp = await f.requestHandoff();
    const before = f.actions.length;
    await f.modelFinished(temp, content);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
    assert.equal(f.compactSince(before), undefined);
    assert.deepEqual(f.messagesSince(before), []);
    assert.ok(f.notifications.some((note) => note.level === "error" || note.level === "warning"), "failure must be reported");
    const afterFailure = f.actions.length;
    await f.settled();
    assert.deepEqual(f.messagesSince(afterFailure), [], "failure must not create an infinite retry");
  }
});

test("cancellation and compaction errors never restart the task", async (t) => {
  {
    const f = fixture(t);
    const temp = await f.requestHandoff();
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.writeFileSync(temp, handoff);
    await f.turn({ outcome: "aborted" });
    const before = f.actions.length;
    await f.settled(true);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
    assert.equal(f.compactSince(before), undefined);
    assert.deepEqual(f.messagesSince(before), []);
    await f.settled();
    assert.deepEqual(f.messagesSince(before), [], "cancelled runs must not auto-restart");
  }
  {
    const f = fixture(t);
    const temp = await f.requestHandoff();
    await f.modelFinished(temp);
    const compact = f.compactSince();
    assert.ok(compact);
    const before = f.actions.length;
    compact.options.onError(new Error("compaction failed"));
    assert.deepEqual(f.messagesSince(before), []);
    assert.ok(f.notifications.some((note) => note.level === "error" || note.level === "warning"));
    await f.settled();
    assert.deepEqual(f.messagesSince(before), []);
  }
});

test("pending user input or a changed session/branch must not be stolen", async (t) => {
  for (const change of ["pending", "session", "branch"]) {
    const f = fixture(t);
    const temp = await f.requestHandoff();
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.writeFileSync(temp, handoff);
    await f.turn();
    if (change === "pending") f.state.pending = true;
    if (change === "session") f.state.session = "other-session";
    if (change === "branch") f.userMessage("使用者改變了任務");
    const before = f.actions.length;
    await f.settled();
    assert.equal(f.compactSince(before), undefined, change);
    assert.deepEqual(f.messagesSince(before), [], change);
    assert.equal(fs.readFileSync(f.file, "utf8"), original, change);
  }
});

test("input or a session change during compaction prevents automatic continuation", async (t) => {
  for (const change of ["pending", "session", "branch"]) {
    const f = fixture(t);
    const temp = await f.requestHandoff();
    await f.modelFinished(temp);
    const compact = f.compactSince();
    assert.ok(compact);
    const before = f.actions.length;
    await f.completeCompact(compact, () => {
      if (change === "pending") f.state.pending = true;
      if (change === "session") f.state.session = "other-session";
      if (change === "branch") f.userMessage("使用者改變了任務");
    });
    assert.deepEqual(f.messagesSince(before), [], change);
  }
});
