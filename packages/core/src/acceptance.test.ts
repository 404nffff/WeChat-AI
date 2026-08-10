import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
  getPersonaBySlug,
  listMemories,
  openDatabase,
  replaceMemories,
  seedPersonas,
  setAssignment,
  upsertBotAccount,
} from "@wechat-ai/db";
import type { LlmClient } from "@wechat-ai/llm";
import { ChatService } from "./chat-service.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

class FakeLlm {
  lastSystem = "";
  constructor(private reply: string) {}
  async chat() {
    return this.reply;
  }
  async chatWithUsage(messages: { role: string; content: string }[]) {
    this.lastSystem = messages.find((m) => m.role === "system")?.content ?? "";
    return {
      text: this.reply,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      model: "fake",
    };
  }
}

describe("acceptance scenarios (Redis)", () => {
  it("rejects unapproved and blocks /角色", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const botId = `bot_acc_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u1",
      displayName: "t",
      botToken: "test-token",
    });
    const chat = new ChatService(db, new FakeLlm("ok") as unknown as LlmClient, {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
    });
    const unapproved = await chat.handleInbound({
      botAccountId: botId,
      peerId: "p1@im.wechat",
      text: "你好",
      contextToken: "t1",
    });
    assert.equal(unapproved.kind, "reject");
    await approvePeer(db, botId, "p1@im.wechat");
    const switchCmd = await chat.handleInbound({
      botAccountId: botId,
      peerId: "p1@im.wechat",
      text: "/角色 女友",
      contextToken: "t2",
    });
    assert.match(switchCmd.text ?? "", /后台|主人/);
    await db.close();
  });

  it("sticky memories per persona", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const botId = `bot_sticky_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u1",
      displayName: "t",
      botToken: "test-token",
    });
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const gf = (await getPersonaBySlug(db, "girlfriend"))!;
    const peer = "sticky@im.wechat";
    await approvePeer(db, botId, peer);
    await setAssignment(db, botId, peer, cat.id);
    await replaceMemories(db, botId, peer, cat.id, ["用户喜欢猫粮"]);
    await replaceMemories(db, botId, peer, gf.id, ["用户喜欢约会"]);
    await setAssignment(db, botId, peer, gf.id);
    assert.equal(
      (await listMemories(db, botId, peer, cat.id))[0]?.content,
      "用户喜欢猫粮",
    );
    await db.close();
  });
});
