import {
  doctorSnapshot,
  getBotCredentials,
  listBotAccounts,
  openDatabase,
  seedPersonas,
} from "@wechat-ai/db";
import { probeToolsHealth } from "@wechat-ai/llm";
import { loadConfig } from "./config.js";
import { isPlaceholderRedisUrl, loadLinuxDoConfig } from "./oauth-linuxdo.js";

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ! ${msg}`);
}
function fail(msg: string): void {
  console.log(`  ✗ ${msg}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  let exitCode = 0;

  console.log("WeChat-AI doctor\n");
  console.log("Environment");
  // Mask password in redis URL for logs
  const maskedRedis = cfg.redisUrl.replace(
    /:\/\/([^:]+):([^@]+)@/,
    "://$1:***@",
  );
  ok(`REDIS_URL=${maskedRedis}`);
  if (isPlaceholderRedisUrl(cfg.redisUrl)) {
    fail(
      "REDIS_URL 仍是占位符。请到 Upstash Console → Connect 复制 rediss:// 连接串写入 .env",
    );
    process.exit(1);
  }
  if (/upstash\.io/i.test(cfg.redisUrl) && cfg.redisUrl.startsWith("redis://")) {
    warn("Upstash 建议使用 rediss://（TLS），当前是 redis://");
  }
  if (!cfg.llmApiKey) {
    fail("LLM_API_KEY missing (platform / admin LLM)");
    exitCode = 1;
  } else {
    ok(
      `platform LLM model=${cfg.llmModel} base=${cfg.llmBaseUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@")}`,
    );
  }
  if (cfg.toolsBaseUrl) {
    ok(`TOOLS_BASE_URL=${cfg.toolsBaseUrl}`);
    if (!cfg.toolsApiKey) {
      warn("TOOLS_API_KEY empty — tools gateway may reject requests");
    }
    const probe = await probeToolsHealth(cfg.toolsBaseUrl);
    if (probe.ok) {
      ok(`tools gateway health: ${probe.detail.slice(0, 80)}`);
    } else {
      fail(`tools gateway unreachable: ${probe.detail}`);
      exitCode = 1;
    }
  } else {
    warn(
      "TOOLS_BASE_URL 未配置 — 用户自定义 LLM 与联网搜索不可用（平台 LLM 仍可用）",
    );
  }
  if (cfg.webSearchEnabled && !cfg.toolsBaseUrl) {
    fail("WEB_SEARCH_ENABLED=true 但未配置 TOOLS_BASE_URL");
    exitCode = 1;
  }
  const oauth = loadLinuxDoConfig();
  if (!oauth) {
    fail("LINUX DO OAuth 未配置 LINUXDO_CLIENT_ID/SECRET/REDIRECT_URI");
    exitCode = 1;
  } else {
    ok(`OAuth redirect=${oauth.redirectUri}`);
    if (!cfg.linuxdoAuthEnabled) {
      warn("LINUXDO_AUTH_ENABLED=false — LINUX DO 登录已关闭（login/callback 拒绝）");
    }
  }
  if (cfg.adminIds.size === 0) {
    warn("LINUXDO_ADMIN_IDS 为空 — 无人自动成为管理员");
  } else {
    ok(`admin ids: ${[...cfg.adminIds].join(",")}`);
  }

  console.log("\nRedis");
  const db = openDatabase(cfg.redisUrl);
  try {
    await db.ping();
    ok("PONG");
  } catch (err) {
    fail(`连接失败: ${(err as Error).message}`);
    process.exit(1);
  }
  await seedPersonas(db);
  const snap = await doctorSnapshot(db);
  ok(
    `users=${snap.users} bots=${snap.bots} personas=${snap.personas} default=${snap.defaultPersona ?? "none"}`,
  );
  ok(
    `peers=${snap.peers} (approved=${snap.approvedPeers} pending=${snap.unapprovedPeers})`,
  );
  if (snap.deepStats) {
    ok(
      `assignments=${snap.assignments} messages=${snap.messages} memories=${snap.memories}`,
    );
  } else {
    warn(
      `assignments/messages/memories 未统计（peers 超过 DOCTOR_DEEP_STATS_MAX_PEERS）`,
    );
  }
  if (!snap.defaultPersona) {
    fail("无默认人设");
    exitCode = 1;
  }
  if (snap.activeBots === 0) warn("尚无机器人 — 用户登录后扫码添加");

  console.log("\nBot credentials (Redis)");
  for (const bot of await listBotAccounts(db)) {
    const creds = await getBotCredentials(db, bot.id);
    if (!creds?.botToken) {
      fail(
        `bot ${bot.id}: missing Redis token (wa:bot:${bot.id}:creds) — re-scan login`,
      );
      exitCode = 1;
    } else {
      ok(`bot ${bot.id} owner=${bot.owner_user_id} token=redis`);
    }
  }

  console.log(exitCode === 0 ? "\nDoctor: PASS" : "\nDoctor: ISSUES FOUND");
  await db.close();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
