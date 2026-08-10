import {
  ILinkClient,
  ILinkError,
  resolveQrOpenUrl,
  type QrcodeStatusResponse,
} from "@wechat-ai/ilink";
import {
  type Db,
  BOT_LOGIN_TTL_SEC,
  type BotLoginSessionRecord,
  getBotAccount,
  getBotLoginSession,
  markBotLoginCancelled,
  saveBotLoginSession,
  upsertBotAccount,
  writeAudit,
} from "@wechat-ai/db";
import type { BotWorkerManager } from "./worker.js";

export type LoginSessionStatus = BotLoginSessionRecord["status"];
export type LoginMode = BotLoginSessionRecord["mode"];
export type LoginSessionView = BotLoginSessionRecord;

interface InternalSession {
  view: LoginSessionView;
  client: ILinkClient;
  qrcode: string;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

/**
 * QR bot login: poll loop is process-local (holds ILinkClient),
 * but the session **view** is stored in Redis so any replica can
 * serve GET status / cancel under load balancing.
 */
export class BotLoginSessionManager {
  /** Local poll ownership only — status is authoritative in Redis. */
  private sessions = new Map<string, InternalSession>();

  constructor(
    private db: Db,
    private worker: BotWorkerManager,
  ) {}

  /**
   * Start QR login.
   * - create (default): new bot id
   * - rebind: update token on existing botId (peers / memories kept)
   */
  async start(
    ownerUserId: string,
    displayName?: string,
    opts?: { rebindBotId?: string },
  ): Promise<LoginSessionView> {
    const rebindBotId = opts?.rebindBotId?.trim();
    let mode: LoginMode = "create";
    let name =
      (displayName?.trim() || "").slice(0, 64) ||
      `bot-${Date.now().toString(36).slice(-6)}`;

    if (rebindBotId) {
      const bot = await getBotAccount(this.db, rebindBotId);
      if (!bot) {
        throw new Error("bot not found");
      }
      // Ownership is enforced by the HTTP route before calling start()
      mode = "rebind";
      name = (displayName?.trim() || bot.display_name || name).slice(0, 64);
    }

    const client = new ILinkClient({ timeoutMs: 30_000 });
    const qr = await client.getBotQrcode(3);
    if (!qr.qrcode) {
      throw new ILinkError(
        qr.errmsg ?? "get_bot_qrcode failed",
        qr.ret,
        undefined,
        qr,
      );
    }

    const sessionId = `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const openUrl = resolveQrOpenUrl(qr);

    const view: LoginSessionView = {
      sessionId,
      displayName: name,
      ownerUserId,
      status: "wait_scan",
      mode,
      rebindBotId: rebindBotId || undefined,
      qrcode: qr.qrcode,
      openUrl,
      message:
        mode === "rebind"
          ? `重新绑定「${name}」：请用微信扫码（好友/人设/记忆将保留）`
          : "请用微信扫描二维码（或打开下方链接）",
      createdAt: now,
      updatedAt: now,
    };

    const session: InternalSession = {
      client,
      qrcode: qr.qrcode,
      stopped: false,
      view,
    };
    this.sessions.set(sessionId, session);
    await this.persist(view);
    void this.pollLoop(sessionId);
    session.timer = setTimeout(() => {
      void this.expireLocal(sessionId);
    }, BOT_LOGIN_TTL_SEC * 1000);
    return { ...view };
  }

  /** Any node: read shared Redis view (falls back to local if still hot). */
  async get(sessionId: string): Promise<LoginSessionView | undefined> {
    const remote = await getBotLoginSession(this.db, sessionId);
    if (remote) return { ...remote };
    const local = this.sessions.get(sessionId);
    return local ? { ...local.view } : undefined;
  }

  /**
   * Cancel from any node: mark Redis cancelled so the poller exits;
   * drop local resources if this process owns the poll.
   */
  async cancel(sessionId: string, ownerUserId?: string): Promise<boolean> {
    if (!ownerUserId) {
      const cur = await getBotLoginSession(this.db, sessionId);
      if (!cur) {
        const local = this.sessions.get(sessionId);
        if (!local) return false;
        local.stopped = true;
        this.dropLocal(sessionId);
        return true;
      }
      ownerUserId = cur.ownerUserId;
    }

    const marked = await markBotLoginCancelled(
      this.db,
      sessionId,
      ownerUserId,
    );
    if (!marked) {
      // Maybe only local (Redis miss) — try local ownership check
      const local = this.sessions.get(sessionId);
      if (!local) return false;
      if (local.view.ownerUserId !== ownerUserId) return false;
      local.stopped = true;
      this.dropLocal(sessionId);
      return true;
    }

    const local = this.sessions.get(sessionId);
    if (local) {
      local.stopped = true;
      local.view = { ...marked };
      this.dropLocal(sessionId);
    }
    return true;
  }

  private async persist(view: LoginSessionView): Promise<void> {
    try {
      await saveBotLoginSession(this.db, view, BOT_LOGIN_TTL_SEC);
    } catch (err) {
      console.error(
        "[bot-login] persist failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async expireLocal(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s && s.view.status !== "confirmed") {
      s.stopped = true;
      s.view.status = "expired";
      s.view.message = "登录超时，请重新发起";
      s.view.updatedAt = new Date().toISOString();
      await this.persist(s.view);
    }
    this.dropLocal(sessionId);
  }

  private dropLocal(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.timer) clearTimeout(s.timer);
    this.sessions.delete(sessionId);
  }

  private async pollLoop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const deadline = Date.now() + 8 * 60_000;
    while (!session.stopped && Date.now() < deadline) {
      // Cross-node cancel
      try {
        const remote = await getBotLoginSession(this.db, sessionId);
        if (!remote || remote.status === "cancelled") {
          session.stopped = true;
          if (remote?.status === "cancelled") {
            session.view = { ...remote };
          }
          this.dropLocal(sessionId);
          return;
        }
      } catch {
        /* continue poll on redis blip */
      }

      try {
        const status = await session.client.getQrcodeStatus(session.qrcode);
        await this.applyStatus(session, status);
        await this.persist(session.view);
        if (
          session.view.status === "confirmed" ||
          session.view.status === "expired" ||
          session.view.status === "error" ||
          session.view.status === "cancelled"
        ) {
          // Keep confirmed/error view in Redis for clients; drop local poll resources
          this.dropLocal(sessionId);
          return;
        }
      } catch (err) {
        if (
          err instanceof ILinkError &&
          (err.body as { aborted?: boolean })?.aborted
        ) {
          session.view.status = "wait_scan";
          session.view.updatedAt = new Date().toISOString();
          await this.persist(session.view);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out|aborted|fetch failed|ECONNRESET|network/i.test(msg)) {
          session.view.message = "等待扫码中…（网络重试）";
          session.view.updatedAt = new Date().toISOString();
          await this.persist(session.view);
          await sleep(800);
          continue;
        }
        session.view.status = "error";
        session.view.message = msg;
        session.view.updatedAt = new Date().toISOString();
        await this.persist(session.view);
        this.dropLocal(sessionId);
        return;
      }
      await sleep(400);
    }

    if (session.view.status !== "confirmed") {
      session.view.status = "expired";
      session.view.message = "登录超时，请重新发起";
      session.view.updatedAt = new Date().toISOString();
      await this.persist(session.view);
    }
    this.dropLocal(sessionId);
  }

  private async applyStatus(
    session: InternalSession,
    status: QrcodeStatusResponse,
  ): Promise<void> {
    const st = (status.status ?? "").toLowerCase();
    session.view.updatedAt = new Date().toISOString();

    if (
      st === "confirmed" ||
      st === "confirmed_login" ||
      st === "success" ||
      Boolean(status.bot_token)
    ) {
      if (!status.bot_token) {
        session.view.status = "error";
        session.view.message = "扫码成功但未返回 bot_token";
        return;
      }
      try {
        if (session.view.mode === "rebind" && session.view.rebindBotId) {
          await this.finishRebind(session, status);
        } else {
          await this.finishCreate(session, status);
        }
      } catch (err) {
        session.view.status = "error";
        session.view.message =
          err instanceof Error ? err.message : "保存账号失败";
      }
      return;
    }

    if (st === "expired" || st === "cancel" || st === "cancelled") {
      session.view.status = "expired";
      session.view.message = `二维码已${st === "expired" ? "过期" : "取消"}，请重新发起`;
      session.stopped = true;
      return;
    }

    if (st.includes("scan") && !st.includes("wait")) {
      session.view.status = "scanned";
      session.view.message = "已扫码，请在手机上确认登录";
    } else {
      session.view.status = "wait_scan";
      session.view.message =
        session.view.mode === "rebind"
          ? "等待微信扫码以重新绑定…"
          : "等待微信扫码…";
    }
  }

  private async finishCreate(
    session: InternalSession,
    status: QrcodeStatusResponse,
  ): Promise<void> {
    const botId = `bot_${Date.now().toString(36)}`;
    const displayName =
      session.view.displayName ||
      status.account_id ||
      status.ilink_bot_id ||
      botId;
    await upsertBotAccount(this.db, {
      id: botId,
      ownerUserId: session.view.ownerUserId,
      displayName,
      accountRef: status.account_id ?? status.ilink_bot_id,
      baseUrl: status.baseurl,
      botToken: status.bot_token!,
    });
    await writeAudit(this.db, "bot_login", session.view.ownerUserId, {
      botId,
      accountRef: status.account_id,
      displayName,
      mode: "create",
    });
    this.worker.ensureLoop(botId);
    session.view.status = "confirmed";
    session.view.botId = botId;
    session.view.message = `登录成功：${displayName}`;
    session.stopped = true;
  }

  private async finishRebind(
    session: InternalSession,
    status: QrcodeStatusResponse,
  ): Promise<void> {
    const botId = session.view.rebindBotId!;
    const existing = await getBotAccount(this.db, botId);
    if (!existing) {
      throw new Error("bot not found during rebind");
    }
    // Keep display name & ownership; refresh token + optional account refs
    const displayName = existing.display_name || session.view.displayName;
    await upsertBotAccount(this.db, {
      id: botId,
      ownerUserId: existing.owner_user_id || session.view.ownerUserId,
      displayName,
      accountRef:
        status.account_id ?? status.ilink_bot_id ?? existing.account_ref ?? undefined,
      baseUrl: status.baseurl ?? existing.base_url ?? undefined,
      botToken: status.bot_token!,
    });
    await writeAudit(this.db, "bot_rebind", session.view.ownerUserId, {
      botId,
      accountRef: status.account_id,
      displayName,
    });
    this.worker.restartBot(botId);
    session.view.status = "confirmed";
    session.view.botId = botId;
    session.view.message = `重新绑定成功：${displayName}（数据已保留）`;
    session.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
