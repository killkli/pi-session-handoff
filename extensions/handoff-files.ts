import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { errorCode } from "./handoff-config.ts";

export async function optionalStat(file: string, inspect = stat) {
  try {
    return await inspect(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function isProjectWritePath(cwd: string, file: string): Promise<boolean> {
  const local = (relative: string) => relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) && relative.split(path.sep)[0].toLowerCase() !== ".git";
  const relative = path.relative(cwd, file);
  if (!relative || !local(relative)) return false;

  // 先檢查最近的既有父目錄，避免 mkdir 或寫檔經由符號連結落在專案外。
  const root = await realpath(cwd);
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    try {
      return local(path.relative(root, await realpath(parent)));
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || parent === path.dirname(parent)) throw error;
    }
  }
}

export async function seedFile(file: string, text: string, force = false): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (!force) return false;
  }

  const existing = await lstat(file);
  if (!existing.isFile()) throw new Error(`不覆寫非一般檔案：${file}`);
  const temp = path.join(path.dirname(file), `.handoff-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { flag: "wx", mode: existing.mode & 0o777 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return true;
}

export async function readOptionalText(file: string): Promise<string> {
  const info = await optionalStat(file, lstat);
  if (!info) return "";
  if (!info.isFile()) throw new Error(`不讀寫非一般檔案：${file}`);
  return readFile(file, "utf8");
}

export async function appendBlock(file: string, current: string, block: string): Promise<void> {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current === "" ? "" : current.endsWith(eol + eol) ? "" : current.endsWith(eol) ? eol : eol + eol;
  await appendFile(file, separator + block.replaceAll("\n", eol));
}

export async function readHandoff(file: string, limit: number): Promise<{ text: string; truncated: boolean } | undefined> {
  const info = await optionalStat(file);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error(`交接路徑不是一般檔案：${file}`);

  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`交接路徑不是一般檔案：${file}`);
    const buffer = Buffer.alloc(4096);
    const decoder = new StringDecoder("utf8");
    let text = "";
    while (text.length <= limit) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        text += decoder.end();
        break;
      }
      text += decoder.write(buffer.subarray(0, bytesRead));
    }
    // 保留完整的 UTF-16 surrogate pair，不把 emoji 截成半個字元。
    const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
    return { text: prefix, truncated: text.length > limit };
  } finally {
    await handle.close();
  }
}

export function nextStepLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+(?:下一步(?=$|\s|[（(：:])|next steps?\b)/i.test(line.trim()));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const match = line.trim().match(/^(?:\d+[.)、]|[-*+])\s+(.+)$/);
    if (match) return match[1];
  }
  return undefined;
}

export function snapshotId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  return `${timestamp}-${randomUUID()}-manual`;
}

export async function writeSnapshot(source: string, dir: string, name: string): Promise<string | undefined> {
  const info = await optionalStat(source);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error(`來源不是一般檔案：${source}`);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error(`快照路徑不是一般資料夾：${dir}`);
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.tmp`);
  try {
    await pipeline(createReadStream(source), createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return file;
}

// 接受舊版秒級命名與新版毫秒＋UUID；不碰旁邊的任意檔案、目錄或符號連結。
const snapshotName = /^\d{8}-(?:\d{6}|\d{9}-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})-manual\.(jsonl|md)$/;

export async function pruneSnapshots(newFile: string, keep: number): Promise<void> {
  const dir = path.dirname(newFile);
  const ext = path.extname(newFile);
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !snapshotName.test(entry.name) || path.extname(entry.name) !== ext) continue;
    const file = path.join(dir, entry.name);
    const info = await optionalStat(file, lstat);
    if (info?.isFile()) files.push({ file, mtime: info.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
  for (const { file } of files.slice(keep)) await rm(file, { force: true });
}
