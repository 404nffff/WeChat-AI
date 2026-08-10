import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./client.js";
import { seedPersonas } from "./seed.js";

function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const root = resolveRepoRoot();
loadEnvFile(path.join(root, ".env"));

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
console.log(
  `[redis] using ${url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`,
);

const db = openDatabase(url);
try {
  const pong = await db.ping();
  console.log(`[redis] ${pong}`);
  await seedPersonas(db);
  console.log("Seeded personas into Redis");
} finally {
  await db.close();
}
