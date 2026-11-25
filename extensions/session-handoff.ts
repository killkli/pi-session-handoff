/**
 * pi-session-handoff — session 開工／收尾 hooks（通用版）
 *
 * 設計取自 Claude Code 的 hooks 做法，改用 Pi 的擴充事件實作：
 *   SessionStart  → before_agent_start     開工時把交接檔注入 context（每 session 一次）
 *   Stop          → agent_before_settle    有未 commit 異動卻沒更新交接檔時，擋一次
 *   PreCompact    → session_before_compact 壓縮前備份 transcript 與交接檔
 *   SessionEnd    → session_shutdown       退場／換 session 前再備一份（Pi 此事件必觸發）
 *
 * 三層分開擺：
 *   交接狀態 → config.handoffPath（預設 docs/HANDOFF.md），每次收尾整份重寫
 *   專案知識 → AGENTS.md（根目錄＝全專案，子目錄＝該模組專屬，Pi 自動載入）
 *   原始紀錄 → <configDir>/transcripts/、<configDir>/handoff-history/（本機產物，勿入版控）
 *
 * 每個專案可用地緣設定覆蓋：<configDir>/handoff.json，其次 ./handoff.json，
 * 環境變數 PI_HANDOFF_* 優先級最高。可用欄位見 README 的設定表。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CONTEXT_TYPE = "session-handoff-context";
const GUARD_TYPE = "session-handoff-guard";
const GITIGNORE_MARK = "# pi-session-handoff（本機產物，勿入版控）";

/**
 * 收尾提醒的三種形態，鍵名與 omp 版 bundle（omp-session-handoff）**故意保持一致**：
 * 同一倉庫兩個 harness 並行時，兩份設定檔可以複製貼上而不用各自翻譯。
 * Pi 沒有「硬擋不讓退場」的形態，所以 block 與 advisory 同行為。
 */
export type NagMode = "advisory" | "block" | "off";

type HandoffConfig = {
  handoffPath: string; // 交接檔（相對專案根）
  staleMinutes: number; // 超過視為過舊
  maxInjectChars: number; // 注入上限
  keepSnapshots: number; // 每種快照保留幾份
  nagMode: NagMode; // advisory／block＝擋一次，off＝只印提醒（舊鍵 nagOnSettle 相容）
  injectOnStart: boolean;
  snapshotOnCompact: boolean;
  snapshotOnShutdown: boolean;
  verifyCommand: string; // 提醒與 status 顯示的驗證指令
  protocolDoc: string; // 協定文件位置，例：AGENTS.md §4
  ignorePrefixes: string[]; // 髒檔檢查額外忽略的路徑前綴
};

const DEFAULTS: HandoffConfig = {
  handoffPath: "docs/HANDOFF.md",
  staleMinutes: 120,
  maxInjectChars: 8000,
  keepSnapshots: 30,
  nagMode: "advisory",
  injectOnStart: true,
  snapshotOnCompact: true,
  snapshotOnShutdown: true,
  verifyCommand: "",
  protocolDoc: "",
  ignorePrefixes: [],
};

type ConfigCache = { cwd: string; source: string; mtimeMs: number; value: HandoffConfig };
let configCache: ConfigCache | undefined;

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.toLowerCase());
  return fallback;
}

/** nagMode 解析；同時相容舊鍵 nagOnSettle（true/false）與環境變數的 0/1。 */
function asNagMode(value: unknown, fallback: NagMode): NagMode {
  if (value === "advisory" || value === "block" || value === "off") return value;
  if (typeof value === "boolean") return value ? "advisory" : "off";
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "advisory" || v === "block" || v === "off") return v as NagMode;
    if (["0", "false", "no"].includes(v)) return "off";
    if (["1", "true", "yes"].includes(v)) return "advisory";
  }
  return fallback;
}

/** 設定來源：預設值 ← <configDir>/handoff.json ← ./handoff.json ← PI_HANDOFF_* 環境變數。 */
function buildConfig(cwd: string): ConfigCache {
  const candidates = [path.join(cwd, CONFIG_DIR_NAME, "handoff.json"), path.join(cwd, "handoff.json")];
  let value = { ...DEFAULTS };
  let source = "預設值";
  let mtimeMs = 0;

  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Record<keyof HandoffConfig, unknown>>;
      value = {
        ...value,
        ...(typeof parsed.handoffPath === "string" ? { handoffPath: parsed.handoffPath } : {}),
        ...({
          staleMinutes: asNumber(parsed.staleMinutes, value.staleMinutes),
          maxInjectChars: asNumber(parsed.maxInjectChars, value.maxInjectChars),
          keepSnapshots: asNumber(parsed.keepSnapshots, value.keepSnapshots),
          // nagMode 為正式鍵；nagOnSettle 是舊鍵（bool），只在沒寫 nagMode 時生效
          nagMode: asNagMode(parsed.nagMode ?? parsed.nagOnSettle, value.nagMode),
          injectOnStart: asBool(parsed.injectOnStart, value.injectOnStart),
          snapshotOnCompact: asBool(parsed.snapshotOnCompact, value.snapshotOnCompact),
          snapshotOnShutdown: asBool(parsed.snapshotOnShutdown, value.snapshotOnShutdown),
          ...(typeof parsed.verifyCommand === "string" ? { verifyCommand: parsed.verifyCommand } : {}),
          ...(typeof parsed.protocolDoc === "string" ? { protocolDoc: parsed.protocolDoc } : {}),
          ...(Array.isArray(parsed.ignorePrefixes)
            ? { ignorePrefixes: parsed.ignorePrefixes.filter((p): p is string => typeof p === "string") }
            : {}),
        } as Partial<HandoffConfig>),
      };
      source = file;
      mtimeMs = stat.mtimeMs;
      break;
    } catch {
      /* 檔案不存在或 JSON 壞掉：續用上一層設定 */
    }
  }

  const env = process.env;
  if (env.PI_HANDOFF_PATH) value.handoffPath = env.PI_HANDOFF_PATH;
  if (env.PI_HANDOFF_STALE_MINUTES) value.staleMinutes = asNumber(env.PI_HANDOFF_STALE_MINUTES, value.staleMinutes);
  if (env.PI_HANDOFF_MAX_INJECT_CHARS) value.maxInjectChars = asNumber(env.PI_HANDOFF_MAX_INJECT_CHARS, value.maxInjectChars);
  if (env.PI_HANDOFF_KEEP_SNAPSHOTS) value.keepSnapshots = asNumber(env.PI_HANDOFF_KEEP_SNAPSHOTS, value.keepSnapshots);
  if (env.PI_HANDOFF_NAG) value.nagMode = asNagMode(env.PI_HANDOFF_NAG, value.nagMode);
  if (env.OMP_HANDOFF_NAG) value.nagMode = asNagMode(env.OMP_HANDOFF_NAG, value.nagMode); // 跨 harness 一起覆寫
  if (env.PI_HANDOFF_VERIFY_COMMAND) value.verifyCommand = env.PI_HANDOFF_VERIFY_COMMAND;
  if (env.PI_HANDOFF_PROTOCOL_DOC) value.protocolDoc = env.PI_HANDOFF_PROTOCOL_DOC;

  return { cwd, source, mtimeMs, value };
}

function getConfig(ctx: ExtensionContext): HandoffConfig {
  const probe = path.join(ctx.cwd, CONFIG_DIR_NAME, "handoff.json");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(probe).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!configCache || configCache.cwd !== ctx.cwd || configCache.mtimeMs !== mtimeMs) {
    configCache = buildConfig(ctx.cwd);
  }
  return configCache.value;
}

// ---- 小工具 ----------------------------------------------------------------
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function ageText(minutes: number): string {
  if (!Number.isFinite(minutes)) return "∞";
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} 分鐘`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)} 小時`;
  return `${(minutes / (60 * 24)).toFixed(1)} 天`;
}

function displayPath(cfg: HandoffConfig): string {
  return cfg.handoffPath.split(path.sep).join("/");
}

type HandoffInfo = {
  file: string;
  exists: boolean;
  mtimeMs: number;
  ageMinutes: number;
  stale: boolean;
  chars: number;
};

function handoffInfo(ctx: ExtensionContext, cfg: HandoffConfig): HandoffInfo {
  const file = path.isAbsolute(cfg.handoffPath) ? cfg.handoffPath : path.join(ctx.cwd, cfg.handoffPath);
  let exists = false;
  let mtimeMs = 0;
  let chars = 0;
  try {
    const stat = fs.statSync(file);
    exists = true;
    mtimeMs = stat.mtimeMs;
    chars = stat.size;
  } catch {
    exists = false;
  }
  const ageMinutes = exists ? (Date.now() - mtimeMs) / 60000 : Number.POSITIVE_INFINITY;
  return { file, exists, mtimeMs, ageMinutes, stale: ageMinutes > cfg.staleMinutes, chars };
}

function readHandoff(info: HandoffInfo, cfg: HandoffConfig): string {
  if (!info.exists) return "";
  try {
    const text = fs.readFileSync(info.file, "utf8");
    return text.length > cfg.maxInjectChars
      ? `${text.slice(0, cfg.maxInjectChars)}\n…（已截斷，完整內容請讀 ${displayPath(cfg)}）`
      : text;
  } catch {
    return "";
  }
}

/** 未 commit 的異動清單；排除本機 agent 產物與交接檔本身。不是 git repo 時回空陣列。
 *  -uall：不要折疊未追蹤目錄，否則 `docs/` 這類目錄會被當成髒檔，
 *  讓「只有交接檔髒」的情況誤觸發提醒。 */
function dirtyLines(ctx: ExtensionContext, cfg: HandoffConfig): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: ctx.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const ignore = [`${CONFIG_DIR_NAME}/`, ".agents/", cfg.handoffPath, ...cfg.ignorePrefixes];
  return out
    .split("\n")
    .map((line) => line.replace(/^\s*\S{1,2}\s+/, "").replace(/^"|"$/g, "").replace(/ -> .*$/, "").trim())
    .filter(Boolean)
    .filter((p) => !ignore.some((prefix) => p.startsWith(prefix)));
}

function prune(dir: string, keep: number): void {
  try {
    const names = fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {
        /* 單檔刪除失敗就跳過 */
      }
    }
  } catch {
    /* 讀不到目錄就跳過 */
  }
}

function snapshot(ctx: ExtensionContext, cfg: HandoffConfig, tag: string): { transcript?: string; handoff?: string } {
  const ts = stamp(new Date());
  const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, "-");
  const result: { transcript?: string; handoff?: string } = {};

  let sessionFile: string | undefined;
  try {
    sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  } catch {
    sessionFile = undefined;
  }
  if (sessionFile && fs.existsSync(sessionFile)) {
    const dir = path.join(ctx.cwd, CONFIG_DIR_NAME, "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    result.transcript = path.join(dir, `${ts}-${safeTag}.jsonl`);
    fs.copyFileSync(sessionFile, result.transcript);
    prune(dir, cfg.keepSnapshots);
  }

  const handoff = path.isAbsolute(cfg.handoffPath) ? cfg.handoffPath : path.join(ctx.cwd, cfg.handoffPath);
  if (fs.existsSync(handoff)) {
    const dir = path.join(ctx.cwd, CONFIG_DIR_NAME, "handoff-history");
    fs.mkdirSync(dir, { recursive: true });
    result.handoff = path.join(dir, `${ts}-${safeTag}.md`);
    fs.copyFileSync(handoff, result.handoff);
    prune(dir, cfg.keepSnapshots);
  }

  return result;
}

/** 分支上是否已有不遜於交接檔更新時間的注入訊息（避免 /reload、/resume 重複注入）。 */
function alreadyInjected(ctx: ExtensionContext, info: HandoffInfo): boolean {
  try {
    const branch = ctx.sessionManager.getBranch() as unknown as Array<{
      type: string;
      customType?: string;
      timestamp?: string;
    }>;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry && entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
        const at = entry.timestamp ? Date.parse(entry.timestamp) : 0;
        return at >= info.mtimeMs;
      }
    }
  } catch {
    /* 讀不到就當作未注入 */
  }
  return false;
}

function nextStepLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s*(下一步|Next steps)/i.test(l.trim()));
  if (start < 0) return "";
  for (const line of lines.slice(start + 1)) {
    const m = line.trim().match(/^(\d+[.、)]|-)\s*(.+)$/);
    if (m) return (m[2] ?? "").trim();
  }
  return "";
}

function report(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else console.log(text);
}

function statusText(ctx: ExtensionContext, cfg: HandoffConfig, info: HandoffInfo): string {
  if (!info.exists) return `HANDOFF ⚠ 不存在（先跑 /handoff-init，收尾跑 /wrap）`;
  const flag = info.stale ? "⚠ 過舊" : "ok";
  return `HANDOFF ${flag}・${ageText(info.ageMinutes)}前更新・髒檔 ${dirtyLines(ctx, cfg).length} 筆`;
}

export function seedHandoff(): string {
  return `# 交接（HANDOFF）

> 本檔於每次 session 收尾時**整份重寫**（\`/wrap\`），不要追加。
> 「下一步」第 1 項即開工入口；沒有內容的段落寫「無」；總長度 ≤ 80 行。

## 目標

這條工作線的最終目標（一兩句）。

## 本次完成

- 具體做了什麼，附檔案路徑或 commit hash

## 進行中（未完成）

- 停在哪個檔案、哪個函式，做到幾成

## 下一步（依優先序）

1. 第一個要做的具體動作，下一個 session 可以直接開工

## 已決定的事與理由

- 決策 → 理由（避免下次重新討論）

## 死路（試過不行的）

- 方法 → 為什麼失敗（避免下次重踩）

## 待我確認

- 需要人決定的事項

## 驗證狀態

- 最後跑的指令與結果；沒跑就寫「未跑」
`;
}

export function seedConfig(): string {
  return `${JSON.stringify(
    {
      handoffPath: DEFAULTS.handoffPath,
      staleMinutes: DEFAULTS.staleMinutes,
      maxInjectChars: DEFAULTS.maxInjectChars,
      keepSnapshots: DEFAULTS.keepSnapshots,
      nagMode: DEFAULTS.nagMode,
      injectOnStart: DEFAULTS.injectOnStart,
      snapshotOnCompact: DEFAULTS.snapshotOnCompact,
      snapshotOnShutdown: DEFAULTS.snapshotOnShutdown,
      verifyCommand: "",
      protocolDoc: "",
      ignorePrefixes: [],
    },
    null,
    2,
  )}\n`;
}

export function agentsSnippet(verifyCommand = ""): string {
  const verify = verifyCommand ? `並跑 \`${verifyCommand}\`。` : "";
  return `<!-- BEGIN pi-session-handoff -->
## Session 交接協定（pi-session-handoff）

三層分開擺：交接狀態 \`docs/HANDOFF.md\`（每次收尾整份重寫）、專案知識 \`AGENTS.md\`
（根目錄＝全專案，子目錄＝該模組專屬）、原始紀錄 \`.pi/transcripts/\`＋\`.pi/handoff-history/\`
（hook 自動存，不入版控）。

- **開工**：先讀交接檔（hook 會自動注入），並確認「下一步」第 1 項再動手。
- **收尾**：有產出就跑 \`/wrap\` 整份重寫交接檔（八段、≤80 行、只寫可驗證事實）。
- **踩坑**：實際遇到阻礙才跑 \`/retro\`；單一模組的坑寫進該模組目錄的 \`AGENTS.md\`，
  能被 lint／驗證腳本取代的就不要寫成文字規則。記憶變雜訊時 \`/memory-defrag\`。
- **hooks**：\`.pi/extensions/\`（Pi 擴充事件），指令 \`/handoff-status\`、\`/handoff-snapshot\`、
  \`/handoff-reload\`。退場 hook 只做檔案備份，交接一律在結束前用 \`/wrap\` 完成。

細節見 \`/skill:session-handoff\`。${verify ? ` 收尾驗證：${verify}` : ""}
<!-- END pi-session-handoff -->
`;
}

// ---- 擴充本體 --------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  let injectedThisSession = false;
  let naggedThisSession = false;

  pi.on("session_start", async (_event, ctx) => {
    injectedThisSession = false;
    naggedThisSession = false;
    if (!ctx.hasUI) return;
    const cfg = getConfig(ctx);
    ctx.ui.setStatus("session-handoff", statusText(ctx, cfg, handoffInfo(ctx, cfg)));
  });

  // 開工注入（SessionStart 對應）：本 session 第一則使用者提示前注入交接內容
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = getConfig(ctx);
    if (injectedThisSession || !cfg.injectOnStart) return;
    if (event.messageType !== "user") return;
    injectedThisSession = true; // 一個 session 只嘗試一次

    const info = handoffInfo(ctx, cfg);
    if (!info.exists) {
      report(ctx, `找不到交接檔 ${displayPath(cfg)}：先跑 /handoff-init 建立，或 /wrap 收尾時寫入。`);
      return;
    }
    if (alreadyInjected(ctx, info)) return;
    const body = readHandoff(info, cfg).trim();
    if (!body) return;

    const updated = new Date(info.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
    const protocol = cfg.protocolDoc ? `（格式見 ${cfg.protocolDoc}）` : "（八段格式見 /skill:session-handoff）";
    return {
      message: {
        customType: CONTEXT_TYPE,
        content:
          `【上次 session 交接（${displayPath(cfg)}，更新於 ${updated}）】\n\n${body}\n\n` +
          `【協定】開工前先向使用者確認「下一步」第 1 項是否仍是現在要做的事；` +
          `收尾時以 /wrap 整份重寫 ${displayPath(cfg)}${protocol}。`,
        display: true,
      },
    };
  });

  // 收尾檢查（Stop 對應）：有未 commit 異動、交接檔卻過舊或不存在 → 擋一次
  pi.on("agent_before_settle", async (event, ctx) => {
    const cfg = getConfig(ctx);
    if (naggedThisSession) return;
    const info = handoffInfo(ctx, cfg);
    if (info.exists && !info.stale) return;
    if (dirtyLines(ctx, cfg).length === 0) return;

    naggedThisSession = true;
    const reason = info.exists
      ? `${displayPath(cfg)} 已超過 ${cfg.staleMinutes} 分鐘未更新`
      : `${displayPath(cfg)} 尚不存在`;
    const verify = cfg.verifyCommand ? `，並跑 \`${cfg.verifyCommand}\`` : "";
    const note =
      `【交接檢查】工作區有未 commit 的異動，但${reason}。\n` +
      `• 收尾階段：用 /wrap 整份重寫交接檔${verify}後提交。\n` +
      `• 還在進行中：回一句「繼續中」即可（本 session 只提醒這一次）。`;

    if (cfg.nagMode === "off") {
      if (ctx.hasUI) ctx.ui.notify(note, "warning");
      return;
    }

    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: GUARD_TYPE, content: note, display: true },
      ],
      continue: true,
    };
  });

  // 壓縮前備份（PreCompact 對應）：只備份，不取消壓縮
  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = getConfig(ctx);
    if (!cfg.snapshotOnCompact) return undefined;
    try {
      const saved = snapshot(ctx, cfg, `compact-${event.reason ?? "manual"}`);
      if (ctx.hasUI && (saved.transcript || saved.handoff)) {
        ctx.ui.notify("壓縮前已備份 transcript 與交接檔", "info");
      }
    } catch {
      /* 備份失敗不可阻擋壓縮 */
    }
    return undefined;
  });

  // 退場備份（SessionEnd 對應）
  pi.on("session_shutdown", async (event, ctx) => {
    const cfg = getConfig(ctx);
    if (cfg.snapshotOnShutdown) {
      try {
        snapshot(ctx, cfg, `end-${event.reason ?? "quit"}`);
      } catch {
        /* 退場不報錯 */
      }
    }
    if (ctx.hasUI) ctx.ui.setStatus("session-handoff", undefined);
  });

  pi.registerCommand("handoff-init", {
    description: "在本專案安裝交接協定：建立交接檔與 .pi/handoff.json、補 .gitignore（agents 參數一併寫入 AGENTS.md）",
    handler: async (args, ctx) => {
      const wantAgents = /(^|\s)(agents|--agents|-a)(\s|$)/i.test(args) || /true/i.test(args);
      const force = /(^|\s)(force|--force|-f)(\s|$)/i.test(args);
      const done: string[] = [];
      const skipped: string[] = [];

      // 1) 交接檔
      const cfgPath = DEFAULTS.handoffPath;
      const handoffFile = path.join(ctx.cwd, cfgPath);
      if (fs.existsSync(handoffFile) && !force) {
        skipped.push(`${cfgPath} 已存在（要覆寫請加 force）`);
      } else {
        fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
        fs.writeFileSync(handoffFile, seedHandoff(), "utf8");
        done.push(`建立 ${cfgPath}`);
      }

      // 2) 設定檔
      const configFile = path.join(ctx.cwd, CONFIG_DIR_NAME, "handoff.json");
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      if (fs.existsSync(configFile) && !force) {
        skipped.push(`${CONFIG_DIR_NAME}/handoff.json 已存在`);
      } else {
        fs.writeFileSync(configFile, seedConfig(), "utf8");
        done.push(`建立 ${CONFIG_DIR_NAME}/handoff.json（可改 staleMinutes、verifyCommand 等）`);
      }

      // 3) .gitignore
      const ignoreFile = path.join(ctx.cwd, ".gitignore");
      const block = `\n${GITIGNORE_MARK}\n${CONFIG_DIR_NAME}/transcripts/\n${CONFIG_DIR_NAME}/handoff-history/\n${CONFIG_DIR_NAME}/settings.local.json\n`;
      let verifyCommand = "";
      if (!fs.existsSync(ignoreFile)) {
        fs.writeFileSync(ignoreFile, block.replace(/^\n/, ""), "utf8");
        done.push("建立 .gitignore 並加入快照規則");
      } else {
        const gitignore = fs.readFileSync(ignoreFile, "utf8");
        if (gitignore.includes(GITIGNORE_MARK)) {
          skipped.push(".gitignore 已含快照規則");
        } else {
          fs.writeFileSync(ignoreFile, gitignore.replace(/\s*$/, "\n") + block, "utf8");
          done.push(".gitignore 加入快照規則");
        }
      }

      // 4) AGENTS.md 協定段（選擇性）
      const agentsFile = path.join(ctx.cwd, "AGENTS.md");
      const marker = "<!-- BEGIN pi-session-handoff -->";
      if (wantAgents) {
        const snippet = agentsSnippet(verifyCommand);
        if (fs.existsSync(agentsFile)) {
          const current = fs.readFileSync(agentsFile, "utf8");
          if (current.includes(marker)) {
            skipped.push("AGENTS.md 已含協定段");
          } else {
            fs.writeFileSync(agentsFile, current.replace(/\s*$/, "\n") + "\n" + snippet, "utf8");
            done.push("AGENTS.md 附加協定段");
          }
        } else {
          fs.writeFileSync(agentsFile, `# AGENTS.md\n\n${snippet}`, "utf8");
          done.push("建立 AGENTS.md 並寫入協定段");
        }
      } else {
        skipped.push("AGENTS.md 未改動（要一併寫入協定段請跑 /handoff-init agents）");
      }

      report(
        ctx,
        [
          "/handoff-init 完成",
          ...done.map((t) => `  ✓ ${t}`),
          ...skipped.map((t) => `  · ${t}`),
          "接著：/wrap 收尾、/retro 萃取經驗、/handoff-status 看健康度。",
        ].join("\n"),
      );
      configCache = undefined; // 讓新設定下一顆事件就生效
    },
  });

  pi.registerCommand("handoff-status", {
    description: "交接檔健康度（存在／更新於／是否過舊／下一步第 1 項／設定來源）",
    handler: async (_args, ctx) => {
      const cfg = getConfig(ctx);
      const info = handoffInfo(ctx, cfg);
      const next = nextStepLine(readHandoff(info, cfg));
      report(
        ctx,
        [
          `交接檔：${info.file}`,
          info.exists
            ? `狀態：${info.stale ? `過舊（門檻 ${cfg.staleMinutes} 分鐘）` : "fresh"}・更新於 ${ageText(info.ageMinutes)}前・${info.chars} bytes`
            : `狀態：不存在（跑 /handoff-init）`,
          `未 commit 異動（已排除 ${CONFIG_DIR_NAME}/、.agents/）：${dirtyLines(ctx, cfg).length} 筆`,
          `設定來源：${configCache?.source ?? "預設值"}｜nag=${cfg.nagMode}・注入=${cfg.injectOnStart}`,
          `驗證指令：${cfg.verifyCommand || "（未設定）"}`,
          next ? `下一步 1.：${next}` : "下一步：（未抓到，確認段落標題為「## 下一步」）",
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("handoff-snapshot", {
    description: `立刻備份 transcript 與交接檔到 ${CONFIG_DIR_NAME}/（手動存檔點）`,
    handler: async (_args, ctx) => {
      const cfg = getConfig(ctx);
      const saved = snapshot(ctx, cfg, "manual");
      report(
        ctx,
        `已備份：${saved.transcript ? path.basename(saved.transcript) : "無 transcript"}` +
          `${saved.handoff ? "／" + path.basename(saved.handoff) : ""}`,
      );
    },
  });

  pi.registerCommand("handoff-reload", {
    description: "重載設定與注入旗標：下一次提示會重新注入最新交接內容",
    handler: async (_args, ctx) => {
      configCache = undefined;
      injectedThisSession = false;
      naggedThisSession = false;
      const cfg = getConfig(ctx);
      report(ctx, `已重載設定（${configCache?.source ?? "預設值"}），下次提示會重新注入交接內容。`);
    },
  });
}
