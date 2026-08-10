import {
  type Db,
  getBotAccount,
  getContextToken,
  getProactiveDayCount,
  incrProactiveDayCount,
  listProactivePeerIds,
  markPeerProactive,
  releaseProactiveLock,
  tryAcquireProactiveLock,
  writeAudit,
  type Peer,
  K,
} from "@wechat-ai/db";
import {
  isProactiveEligible,
  mergeBotProactiveConfig,
  type ChatService,
  type ReplyPart,
} from "@wechat-ai/core";
import type { ILinkClient } from "@wechat-ai/ilink";

export interface ProactiveSchedulerOptions {
  db: Db;
  chat: ChatService;
  /** Global hard switch */
  globalEnabled: boolean;
  defaultIdleHours: number;
  defaultMinIntervalHours: number;
  defaultMaxPerDay: number;
  defaultQuietHours: string;
  scanIntervalSec: number;
  maxPerScan: number;
  lockTtlSec: number;
  attemptCooldownHours: number;
  log?: (msg: string, extra?: unknown) => void;
  /**
   * Bots this process currently long-polls (has live ILinkClient).
   */
  getLocalBotIds: () => string[];
  getClient: (botId: string) => ILinkClient | undefined;
  /**
   * Serialize send with inbound reply chain for the same peer.
   * Handler should perform send + mark success.
   */
  runOnPeerChain: (
    botId: string,
    peerId: string,
    fn: () => Promise<void>,
  ) => Promise<void>;
  sendParts: (
    client: ILinkClient,
    peerId: string,
    contextToken: string,
    parts: ReplyPart[],
    ownerUserId: string,
  ) => Promise<void>;
}

/**
 * Periodic scan: idle peers with proactive enabled get an LLM-generated nudge.
 */
export class ProactiveScheduler {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * Bumped on every stop(). An in-flight tick re-arms the chain from its
   * `finally`, which stop() cannot cancel — without this, a disable/enable
   * toggle during a tick leaves the old chain running untracked alongside the
   * new one and the scan rate doubles per toggle.
   */
  private gen = 0;

  constructor(private opts: ProactiveSchedulerOptions) {}

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   *
   * `globalEnabled` is latched by start(): the scheduler early-returns and
   * leaves `stopped = true`, so flipping it on has to re-enter start() rather
   * than just mutate the flag.
   */
  applyRuntimeOptions(patch: Partial<ProactiveSchedulerOptions>): void {
    const wasEnabled = this.opts.globalEnabled;
    Object.assign(this.opts, patch);
    if (patch.globalEnabled === undefined) return;
    if (!wasEnabled && this.opts.globalEnabled) {
      this.stop();
      this.start();
    } else if (wasEnabled && !this.opts.globalEnabled) {
      this.stop();
    }
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.opts.globalEnabled) {
      this.opts.log?.(
        "[proactive] disabled (PROACTIVE_ENABLED=false); scheduler not started",
      );
      return;
    }
    this.stopped = false;
    this.opts.log?.(
      `[proactive] scheduler start interval=${this.opts.scanIntervalSec}s ` +
        `maxPerScan=${this.opts.maxPerScan}`,
    );
    this.scheduleNext(2_000, this.gen);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(ms: number, gen: number): void {
    if (this.stopped || gen !== this.gen) return;
    this.timer = setTimeout(() => {
      if (gen !== this.gen) return;
      void this.tick()
        .catch((err) => {
          this.opts.log?.(
            `[proactive] tick error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        })
        .finally(() => {
          // A tick started before a stop() must not resurrect the chain.
          this.scheduleNext(this.opts.scanIntervalSec * 1000, gen);
        });
    }, ms);
  }

  /** Exposed for tests / manual trigger */
  async tick(): Promise<{ sent: number; skipped: number; considered: number }> {
    if (this.stopped || !this.opts.globalEnabled) {
      return { sent: 0, skipped: 0, considered: 0 };
    }
    if (this.running) {
      return { sent: 0, skipped: 0, considered: 0 };
    }
    this.running = true;
    let sent = 0;
    let skipped = 0;
    let considered = 0;
    try {
      const botIds = this.opts.getLocalBotIds();
      if (!botIds.length) return { sent, skipped, considered };

      const budget = Math.max(1, this.opts.maxPerScan);

      for (const botId of botIds) {
        if (this.stopped || sent >= budget) break;
        const client = this.opts.getClient(botId);
        if (!client) continue;

        const bot = await getBotAccount(this.opts.db, botId);
        if (!bot || bot.status !== "active") continue;

        const cfg = mergeBotProactiveConfig(bot, {
          idleHours: this.opts.defaultIdleHours,
          minIntervalHours: this.opts.defaultMinIntervalHours,
          maxPerDay: this.opts.defaultMaxPerDay,
          quietHours: this.opts.defaultQuietHours,
        });
        if (!cfg.enabled) continue;

        const peerIds = await listProactivePeerIds(this.opts.db, botId);
        if (!peerIds.length) continue;

        for (const peerId of peerIds) {
          if (this.stopped || sent >= budget) break;
          considered++;

          const peer = await this.opts.db.getJson<Peer>(
            K.peer(botId, peerId),
          );
          if (!peer) continue;

          const contextToken = await getContextToken(
            this.opts.db,
            botId,
            peerId,
          );
          const dayCount = await getProactiveDayCount(
            this.opts.db,
            botId,
            peerId,
          );

          const elig = isProactiveEligible({
            botStatus: bot.status,
            botProactiveEnabled: cfg.enabled ? 1 : 0,
            peerApproved: peer.approved,
            peerProactiveEnabled: peer.proactive_enabled,
            hasContextToken: Boolean(contextToken),
            lastActivityAt: peer.last_activity_at,
            peerCreatedAt: peer.created_at,
            lastProactiveAt: peer.last_proactive_at,
            lastProactiveAttemptAt: peer.last_proactive_attempt_at,
            dayCount,
            idleHours: cfg.idleHours,
            minIntervalHours: cfg.minIntervalHours,
            maxPerDay: cfg.maxPerDay,
            quietHours: cfg.quietHours,
            attemptCooldownHours: this.opts.attemptCooldownHours,
          });

          if (!elig.ok) {
            skipped++;
            continue;
          }

          const locked = await tryAcquireProactiveLock(
            this.opts.db,
            botId,
            peerId,
            this.opts.lockTtlSec,
          );
          if (!locked) {
            this.opts.log?.(
              `[proactive] bot=${botId} peer=${peerId} action=lock_miss`,
            );
            skipped++;
            continue;
          }

          try {
            await this.opts.runOnPeerChain(botId, peerId, async () => {
              // Re-check context in case it was cleared
              const tok =
                contextToken ||
                (await getContextToken(this.opts.db, botId, peerId));
              if (!tok) {
                await markPeerProactive(this.opts.db, botId, peerId, {
                  sent: false,
                });
                this.opts.log?.(
                  `[proactive] bot=${botId} peer=${peerId} action=no_ctx`,
                );
                skipped++;
                return;
              }

              const result = await this.opts.chat.handleProactive({
                botAccountId: botId,
                peerId,
                contextToken: tok,
                idleHours: elig.idleHoursActual ?? cfg.idleHours,
              });

              if (result.kind === "skip" || result.kind === "reject") {
                await markPeerProactive(this.opts.db, botId, peerId, {
                  sent: false,
                });
                this.opts.log?.(
                  `[proactive] bot=${botId} peer=${peerId} action=skip ` +
                    `reason=${result.skipReason ?? result.kind} ` +
                    `idle=${(elig.idleHoursActual ?? 0).toFixed(1)}h`,
                );
                skipped++;
                return;
              }

              if (result.kind !== "reply") {
                await markPeerProactive(this.opts.db, botId, peerId, {
                  sent: false,
                });
                skipped++;
                return;
              }

              let parts: ReplyPart[] =
                result.parts && result.parts.length > 0
                  ? result.parts
                  : result.bubbles && result.bubbles.length > 0
                    ? result.bubbles.map((t) => ({
                        kind: "text" as const,
                        text: t,
                      }))
                    : result.text
                      ? [{ kind: "text" as const, text: result.text }]
                      : [];

              if (!parts.length) {
                await markPeerProactive(this.opts.db, botId, peerId, {
                  sent: false,
                });
                skipped++;
                return;
              }

              const ownerUserId = bot.owner_user_id || "";
              await this.opts.sendParts(
                client,
                peerId,
                tok,
                parts,
                ownerUserId,
              );

              await markPeerProactive(this.opts.db, botId, peerId, {
                sent: true,
              });
              await incrProactiveDayCount(this.opts.db, botId, peerId);
              await writeAudit(this.opts.db, "proactive_sent", "system", {
                botId,
                peerId,
                idleHours: elig.idleHoursActual,
                personaId: result.personaId,
              });
              sent++;
              this.opts.log?.(
                `[proactive] bot=${botId} peer=${peerId} action=send ` +
                  `idle=${(elig.idleHoursActual ?? 0).toFixed(1)}h ` +
                  `parts=${parts.length}`,
              );
            });
          } catch (err) {
            await markPeerProactive(this.opts.db, botId, peerId, {
              sent: false,
            }).catch(() => undefined);
            this.opts.log?.(
              `[proactive] bot=${botId} peer=${peerId} action=error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          } finally {
            await releaseProactiveLock(this.opts.db, botId, peerId).catch(
              () => undefined,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
    if (sent || considered) {
      this.opts.log?.(
        `[proactive] tick done considered=${considered} sent=${sent} skipped=${skipped}`,
      );
    }
    return { sent, skipped, considered };
  }
}
