/**
 * Offline acceptance gate: unit tests + diag + DB seed invariants.
 * Does not require live WeChat / real LLM.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(root, "data", "wechat-ai.db");

function run(cmd, args, env = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(" ")} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

console.log("=== WeChat-AI offline acceptance ===");
console.log("root:", root);

run("pnpm", ["test"]);

// ensure schema + seed
run("pnpm", ["db:migrate"], { WECHAT_AI_DB_PATH: dbPath });
run("pnpm", ["db:seed"], { WECHAT_AI_DB_PATH: dbPath });
run("pnpm", ["diag"], {
  WECHAT_AI_DB_PATH: dbPath,
  LLM_API_KEY: process.env.LLM_API_KEY || "sk-accept-placeholder",
  WECHAT_AI_TOKEN: process.env.WECHAT_AI_TOKEN || "accept-token",
});

// structural checks
const required = [
  "apps/api/public/admin.html",
  "apps/api/public/chatflow.html",
  "docs/runbook.md",
  "docs/e2e-checklist.md",
  "docs/admin-api.md",
  "docs/ai-gateway.md",
  "docs/chatflow.md",
  "docs/adr/0001-ilink-direct.md",
  "packages/ilink/src/client.ts",
  "packages/core/src/chat-service.ts",
  "packages/core/src/chatflow/engine.ts",
  "packages/db/src/schema.ts",
  "packages/db/src/llm-provider-repos.ts",
  "huggingface/wechat-ai-tools/app.py",
  "huggingface/wechat-ai-tools/Dockerfile",
];
for (const rel of required) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.error("MISSING file:", rel);
    process.exit(1);
  }
  console.log("  ✓ file", rel);
}

if (!fs.existsSync(dbPath)) {
  console.error("DB missing after migrate/seed");
  process.exit(1);
}
console.log("  ✓ db", dbPath);

console.log("\n=== OFFLINE ACCEPTANCE: PASS ===");
console.log("True WeChat E2E still needs: pnpm ilink:login + real LLM key");
console.log("See docs/e2e-checklist.md");
