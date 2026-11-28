import { realpath } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function countDirty(
  pi: ExtensionAPI,
  cwd: string,
  handoffFile: string,
  ignorePrefixes: string[],
): Promise<number | undefined> {
  const options = { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
  try {
    const [root, status, physicalCwd] = await Promise.all([
      pi.exec("git", ["rev-parse", "--show-toplevel"], options),
      pi.exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames"], options),
      realpath(cwd),
    ]);
    if (root.code !== 0 || status.code !== 0 || root.truncated || status.truncated) return undefined;

    const repo = root.stdout.replace(/\n$/, "");
    const relative = (file: string) => path.relative(repo, file).split(path.sep).join("/");
    const toRepoPath = (file: string) => relative(path.resolve(physicalCwd, path.relative(cwd, path.resolve(cwd, file))));
    const directories = [repo, physicalCwd].flatMap((base) =>
      [CONFIG_DIR_NAME, ".agents"].map((dir) => relative(path.join(base, dir)) + "/"),
    );
    const prefixes = directories.concat(ignorePrefixes.map((p) => toRepoPath(p) + (p.endsWith("/") || p.endsWith(path.sep) ? "/" : "")));
    const handoff = toRepoPath(handoffFile);
    const ignored = (file: string) => file === handoff || prefixes.some((prefix) => prefix !== "" && file.startsWith(prefix));

    // Porcelain v1 -z 的路徑一律相對於儲存庫根，不會跳脫；重新命名／複製的舊路徑另佔一個欄位。
    const fields = status.stdout.split("\0");
    let count = 0;
    for (let i = 0; i < fields.length - 1; i++) {
      const record = fields[i];
      const destination = record.slice(3);
      const source = /[RC]/.test(record.slice(0, 2)) ? fields[++i] : undefined;
      if (!ignored(destination) || (source && !ignored(source))) count++;
    }
    return count;
  } catch {
    return undefined;
  }
}
