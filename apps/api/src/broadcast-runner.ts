import {
  type BroadcastJob,
  type Db,
  cancelBroadcastJob,
  findNextPendingBroadcast,
  getBroadcastJob,
  pushBroadcastFailure,
  releaseBroadcastLock,
  renewBroadcastLock,
  saveBroadcastJob,
  setBroadcastActive,
  tryAcquireBroadcastLock,
  writeAudit,
} from "@wechat-ai/db";

export type AdminSendResult = {
  ok: boolean;
  reason?:
    | "empty"
    | "no_context_token"
    | "no_credentials"
    | "ilink_error"
    | "cancelled";
  error?: string;
};

export interface BroadcastRunnerOptions {
  db: Db;
  workerId: string;
  /** Interval between send attempts (ms) */
  intervalMs: number;
  /** Tick interval to look for new jobs (ms) */
  pollIntervalMs?: number;
  lockTtlSec?: number;
  adminSendText: (
    botId: string,
    peerId: string,
    text: string,
  ) => Promise<AdminSendResult>;
  /** Serialize with inbound replies for the same peer when possible */
  runOnPeerChain?: (
    botId: string,
    peerId: string,
    fn: () => Promise<void>,
  ) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * Serial async processor for admin broadcast jobs stored in Redis.
 * Only one job runs at a time fleet-wide (lock + active pointer).
 */
export class BroadcastRunner {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private wakeRequested = false;

  constructor(private opts: BroadcastRunnerOptions) {}

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   * Values are re-read on every tick, so a longer pollIntervalMs only takes
   * hold after the currently armed timer fires.
   */
  applyRuntimeOptions(patch: {
    intervalMs?: number;
    pollIntervalMs?: number;
    lockTtlSec?: number;
  }): void {
    if (patch.intervalMs !== undefined) {
      this.opts.intervalMs = Math.max(50, patch.intervalMs);
    }
    if (patch.pollIntervalMs !== undefined) {
      this.opts.pollIntervalMs = Math.max(250, patch.pollIntervalMs);
    }
    if (patch.lockTtlSec !== undefined) {
      this.opts.lockTtlSec = Math.max(10, patch.lockTtlSec);
    }
  }

  start(): void {
    this.stopped = false;
    this.opts.log?.(
      `[broadcast] runner start interval=${this.opts.intervalMs}ms`,
    );
    this.scheduleNext(1_500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Call after creating a job so we don't wait for the next poll. */
  wake(): void {
    this.wakeRequested = true;
    if (this.stopped || this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(50);
  }

  private scheduleNext(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => {
          this.opts.log?.(
            `[broadcast] tick error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        })
        .finally(() => {
          const next = this.wakeRequested
            ? 200
            : (this.opts.pollIntervalMs ?? 2_000);
          this.wakeRequested = false;
          this.scheduleNext(next);
        });
    }, ms);
  }

  /** Exposed for tests */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const job = await findNextPendingBroadcast(this.opts.db);
      if (!job) return;
      await this.processJob(job);
    } finally {
      this.running = false;
    }
  }

  private async processJob(initial: BroadcastJob): Promise<void> {
    const lockTtl = this.opts.lockTtlSec ?? 60;
    const got = await tryAcquireBroadcastLock(
      this.opts.db,
      initial.id,
      this.opts.workerId,
      lockTtl,
    );
    if (!got) {
      this.opts.log?.(
        `[broadcast] job=${initial.id} lock held by another worker`,
      );
      return;
    }

    let job = (await getBroadcastJob(this.opts.db, initial.id)) ?? initial;
    if (job.status === "cancelled" || job.status === "completed") {
      await releaseBroadcastLock(
        this.opts.db,
        job.id,
        this.opts.workerId,
      );
      return;
    }

    try {
      if (job.status === "pending") {
        job.status = "running";
        job.startedAt = job.startedAt || new Date().toISOString();
        await saveBroadcastJob(this.opts.db, job);
      }
      await setBroadcastActive(this.opts.db, job.id);

      // Keep a local working copy. Never replace it wholesale with a Redis
      // re-read — unflushed stats/cursor would be wiped and the job can
      // finish as e.g. 1/N after only the last in-batch increment survives.
      job.stats = job.stats ?? { total: 0, sent: 0, skipped: 0, failed: 0 };
      job.failures = job.failures ?? [];
      const recipients = job.recipients ?? [];
      const text = job.text;
      let cursor = Math.max(0, job.cursor ?? 0);
      let sinceFlush = 0;
      let sinceCancelCheck = 0;
      let lastRenew = Date.now();
      // With remote Redis, a GET every message dominates wall time. Check cancel
      // every few sends (and always before first / after last).
      const cancelCheckEvery = Math.max(
        1,
        Math.min(5, Math.floor(1000 / Math.max(50, this.opts.intervalMs))),
      );
      // Flush often enough that the admin UI progress is useful, but not every
      // single send on a high-latency Redis.
      const flushEvery = Math.max(1, Math.min(5, cancelCheckEvery));

      this.opts.log?.(
        `[broadcast] start job=${job.id} total=${recipients.length} cursor=${cursor}`,
      );

      while (cursor < recipients.length) {
        if (this.stopped) break;

        // Periodic cancel poll — do NOT assign job = live (stale stats).
        if (sinceCancelCheck === 0) {
          const live = await getBroadcastJob(this.opts.db, job.id);
          if (!live || live.status === "cancelled") {
            job.status = "cancelled";
            job.finishedAt = new Date().toISOString();
            job.cursor = cursor;
            await saveBroadcastJob(this.opts.db, job);
            break;
          }
        }
        sinceCancelCheck =
          (sinceCancelCheck + 1) % cancelCheckEvery;

        const target = recipients[cursor]!;
        const sendOnce = async () => {
          const result = await this.opts.adminSendText(
            target.botId,
            target.peerId,
            text,
          );
          if (result.ok) {
            job.stats.sent += 1;
          } else if (
            result.reason === "no_context_token" ||
            result.reason === "no_credentials" ||
            result.reason === "empty"
          ) {
            job.stats.skipped += 1;
          } else {
            job.stats.failed += 1;
            pushBroadcastFailure(job, {
              botId: target.botId,
              peerId: target.peerId,
              error: result.error || result.reason || "send_failed",
            });
          }
        };

        try {
          if (this.opts.runOnPeerChain) {
            await this.opts.runOnPeerChain(
              target.botId,
              target.peerId,
              sendOnce,
            );
          } else {
            await sendOnce();
          }
        } catch (err) {
          job.stats.failed += 1;
          pushBroadcastFailure(job, {
            botId: target.botId,
            peerId: target.peerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        cursor += 1;
        job.cursor = cursor;
        sinceFlush += 1;

        const now = Date.now();
        if (now - lastRenew > 15_000) {
          await renewBroadcastLock(
            this.opts.db,
            job.id,
            this.opts.workerId,
            lockTtl,
          );
          lastRenew = now;
        }

        if (sinceFlush >= flushEvery || cursor >= recipients.length) {
          await saveBroadcastJob(this.opts.db, job);
          sinceFlush = 0;
        }

        if (cursor < recipients.length && this.opts.intervalMs > 0) {
          await sleep(this.opts.intervalMs);
        }
      }

      // Finalize if not cancelled mid-way
      const final = await getBroadcastJob(this.opts.db, job.id);
      if (final && final.status === "running") {
        // Prefer in-memory progress; Redis copy may lag between flushes.
        final.cursor = cursor;
        final.stats = job.stats;
        final.failures = job.failures;
        if (cursor >= recipients.length) {
          final.status = "completed";
          final.finishedAt = new Date().toISOString();
        } else if (this.stopped) {
          // leave as running for another worker / restart
          final.status = "running";
        }
        await saveBroadcastJob(this.opts.db, final);
        job = final;
      } else if (
        final &&
        final.status === "cancelled" &&
        job.status !== "cancelled"
      ) {
        // Cancel won the race after the loop; still persist latest counts.
        final.cursor = cursor;
        final.stats = job.stats;
        final.failures = job.failures;
        await saveBroadcastJob(this.opts.db, final);
        job = final;
      }

      if (job.status === "completed" || job.status === "cancelled") {
        await writeAudit(this.opts.db, "admin_broadcast_finished", "system", {
          jobId: job.id,
          status: job.status,
          stats: job.stats,
        });
        await setBroadcastActive(this.opts.db, null);
        this.opts.log?.(
          `[broadcast] done job=${job.id} status=${job.status} ` +
            `sent=${job.stats.sent} skipped=${job.stats.skipped} failed=${job.stats.failed}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = message;
      job.finishedAt = new Date().toISOString();
      await saveBroadcastJob(this.opts.db, job);
      await setBroadcastActive(this.opts.db, null);
      await writeAudit(this.opts.db, "admin_broadcast_failed", "system", {
        jobId: job.id,
        error: message,
      });
      this.opts.log?.(`[broadcast] job=${job.id} failed: ${message}`);
    } finally {
      await releaseBroadcastLock(
        this.opts.db,
        initial.id,
        this.opts.workerId,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// re-export for routes that may cancel via runner-less path
export { cancelBroadcastJob };
