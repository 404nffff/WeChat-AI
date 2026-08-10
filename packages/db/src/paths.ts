import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  if (fs.existsSync(path.join(fromFile, "pnpm-workspace.yaml"))) {
    return fromFile;
  }
  return path.resolve(start);
}

export function defaultDbPath(): string {
  const root = resolveRepoRoot();
  const raw = process.env.WECHAT_AI_DB_PATH?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? path.normalize(raw) : path.join(root, raw);
  }
  return path.join(root, "data", "wechat-ai.db");
}
