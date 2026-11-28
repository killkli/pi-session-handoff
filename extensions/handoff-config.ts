import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const DEFAULTS = {
  handoffPath: "docs/HANDOFF.md",
  staleMinutes: 120,
  maxInjectChars: 8000,
  keepSnapshots: 30,
  verifyCommand: "",
  ignorePrefixes: [] as string[],
};

type HandoffConfig = typeof DEFAULTS;
type ConfigResult = { config: HandoffConfig; sources: string[]; warnings: string[] };

export const projectConfigPath = path.join(CONFIG_DIR_NAME, "handoff.json");

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function numeric(value: unknown, integer: boolean): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return integer && !Number.isSafeInteger(n) ? undefined : n;
}

function applyConfig(result: ConfigResult, src: Record<string, unknown>, source: string): void {
  const { config, warnings } = result;
  for (const key of ["staleMinutes", "maxInjectChars", "keepSnapshots"] as const) {
    if (!Object.hasOwn(src, key)) continue;
    const value = numeric(src[key], key !== "staleMinutes");
    if (value === undefined) warnings.push(`${source}：${key} 無效，保留上一層設定`);
    else config[key] = value;
  }
  if (Object.hasOwn(src, "handoffPath")) {
    const value = src.handoffPath;
    if (typeof value === "string" && value.trim() !== "" && !value.includes("\0")) config.handoffPath = value;
    else warnings.push(`${source}：handoffPath 無效，保留上一層設定`);
  }
  if (Object.hasOwn(src, "verifyCommand")) {
    if (typeof src.verifyCommand === "string") config.verifyCommand = src.verifyCommand;
    else warnings.push(`${source}：verifyCommand 無效，保留上一層設定`);
  }
  if (Object.hasOwn(src, "ignorePrefixes")) {
    const value = src.ignorePrefixes;
    if (Array.isArray(value) && value.every((p): p is string => typeof p === "string" && p.trim() !== "")) {
      config.ignorePrefixes = value;
    } else {
      warnings.push(`${source}：ignorePrefixes 須為不含空白項的字串陣列，保留上一層設定`);
    }
  }
}

/** 只在手動指令執行時讀取，避免跨專案共用快取或遺漏任一來源的變更。 */
export async function loadConfig(cwd: string): Promise<ConfigResult> {
  const result: ConfigResult = { config: { ...DEFAULTS }, sources: [], warnings: [] };
  for (const source of [projectConfigPath, "handoff.json"]) {
    try {
      const file = path.join(cwd, source);
      if (!(await stat(file)).isFile()) throw new Error("不是一般檔案");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("需要 JSON 物件");
      applyConfig(result, value as Record<string, unknown>, source);
      result.sources.push(source);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") result.warnings.push(`${source} 無法讀取或解析（須為 JSON 物件）`);
    }
  }

  const env = Object.fromEntries([
    ["handoffPath", process.env.PI_HANDOFF_PATH],
    ["staleMinutes", process.env.PI_HANDOFF_STALE_MINUTES],
    ["maxInjectChars", process.env.PI_HANDOFF_MAX_INJECT_CHARS],
    ["keepSnapshots", process.env.PI_HANDOFF_KEEP_SNAPSHOTS],
    ["verifyCommand", process.env.PI_HANDOFF_VERIFY_COMMAND],
  ].filter(([, value]) => value !== undefined));
  if (Object.keys(env).length > 0) {
    applyConfig(result, env, "PI_HANDOFF_*");
    result.sources.push("PI_HANDOFF_*");
  }
  return result;
}

export function formatSources(sources: string[]): string {
  return ["預設值", ...sources].join(" → ");
}
