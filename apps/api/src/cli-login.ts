import { loginWithQrcode, ILinkClient } from "@wechat-ai/ilink";
import {
  openDatabase,
  upsertBotAccount,
  writeAudit,
} from "@wechat-ai/db";
import { loadConfig } from "./config.js";

function parseArgs(argv: string[]): { name?: string; owner?: string } {
  const out: { name?: string; owner?: string } = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      out.name = args[++i];
    } else if (args[i] === "--owner" && args[i + 1]) {
      out.owner = args[++i];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(cfg.redisUrl);

  console.log("Requesting iLink QR code…");
  console.log("推荐：浏览器打开 /app → 机器人 → 扫码添加（token 写入 Redis）。");
  console.log("Open WeChat → scan the QR (ClawBot / 插件扫码).\n");
  if (args.name) console.log(`Display name: ${args.name}\n`);

  const client = new ILinkClient({ timeoutMs: 30_000 });
  const result = await loginWithQrcode({
    client,
    timeoutMs: 8 * 60_000,
    onQrcode: (info) => {
      console.log("qrcode id:", info.qrcode);
      const openUrl = info.qrcodeUrl || info.qrcodeImgContent;
      if (openUrl?.startsWith("http")) {
        console.log("\n>>> 请在手机微信中打开此链接完成扫码/授权：\n");
        console.log(openUrl);
        console.log("\n");
      }
      console.log("等待扫码（最长约 8 分钟，请勿关闭窗口）…\n");
    },
    onStatus: (st) => {
      process.stdout.write(`\rstatus: ${st.padEnd(16)}`);
    },
  });

  console.log("\n\nLogin confirmed.");

  const botId = `bot_${Date.now().toString(36)}`;
  const displayName =
    args.name ?? result.accountId ?? `bot-${botId.slice(-6)}`;
  const ownerUserId = args.owner ?? "cli";

  await upsertBotAccount(db, {
    id: botId,
    ownerUserId,
    displayName,
    accountRef: result.accountId,
    baseUrl: result.baseUrl,
    botToken: result.botToken,
  });
  await writeAudit(db, "bot_login", "cli", {
    botId,
    accountRef: result.accountId,
    displayName,
  });

  console.log("Saved bot:", botId, `(${displayName})`);
  console.log("Token: Redis key wa:bot:" + botId + ":creds");
  console.log("多 Bot：再次运行 pnpm ilink:login -- --name 第二个号");
  console.log("Start: pnpm dev  →  http://127.0.0.1:8787/app");
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
