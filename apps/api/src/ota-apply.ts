/**
 * Local OTA apply: hash scan, download blobs, staging, atomic swap, optional install.
 * Invoked by BotWorkerManager when a Redis update job is pending.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  clearWorkerUpdateJob,
  diffReleaseFiles,
  getBlob,
  getReleaseMeta,
  getWorkerUpdateJob,
  isAllowedOtaPath,
  normalizeOtaPath,
  setWorkerUpdateStatus,
  type Db,
  type NodeUpdateJob,
  type NodeUpdateStatus,
  type ReleaseFileEntry,
  type ReleaseMeta,
} from "@wechat-ai/db";

export interface OtaApplyOptions {
  db: Db;
  workerId: string;
  repoRoot: string;
  appVersion: string;
  stagingDir: string;
  allowInstall: boolean;
  log?: (msg: string, extra?: unknown) => void;
  /** Called after files applied, before process exit */
  beforeRestart?: () => void | Promise<void>;
}

function sha256File(abs: string): string | null {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const h = createHash("sha256");
    h.update(fs.readFileSync(abs));
    return h.digest("hex");
  } catch {
    return null;
  }
}

/** Walk whitelist trees under repo root and return path → sha256. */
export function scanLocalOtaHashes(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = path.resolve(repoRoot);

  const tryFile = (relPosix: string) => {
    if (!isAllowedOtaPath(relPosix)) return;
    const abs = path.join(root, ...relPosix.split("/"));
    const hash = sha256File(abs);
    if (hash) out.set(relPosix, hash);
  };

  for (const f of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
  ]) {
    tryFile(f);
  }

  const walk = (absDir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (
        name === "node_modules" ||
        name === "data" ||
        name === ".git" ||
        name === ".wa-update-staging" ||
        name === ".wa-backup"
      ) {
        continue;
      }
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const abs = path.join(absDir, name);
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        tryFile(rel.replace(/\\/g, "/"));
      }
    }
  };

  for (const dir of [
    "apps/api",
    "packages/core",
    "packages/db",
    "packages/ilink",
    "packages/llm",
    "scripts",
  ]) {
    const abs = path.join(root, ...dir.split("/"));
    if (fs.existsSync(abs)) walk(abs, dir);
  }

  return out;
}

function resolveStagingAbs(repoRoot: string, stagingDir: string): string {
  if (path.isAbsolute(stagingDir)) return stagingDir;
  return path.join(path.resolve(repoRoot), stagingDir);
}

function safeWriteFile(abs: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + ".tmp." + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

async function runPnpmInstall(repoRoot: string, log?: OtaApplyOptions["log"]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["install", "--frozen-lockfile"],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      },
    );
    let err = "";
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        log?.(`[ota] pnpm install exit ${code}: ${err.slice(0, 500)}`);
        reject(new Error(`pnpm_install_failed:${code}`));
      }
    });
  });
}

async function downloadNeeded(
  db: Db,
  needed: ReleaseFileEntry[],
  onProgress: (done: number, bytesDone: number) => Promise<void>,
): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  let done = 0;
  let bytesDone = 0;
  for (const f of needed) {
    const buf = await getBlob(db, f.sha256);
    if (!buf) throw new Error(`blob_missing:${f.path}`);
    if (buf.length !== f.size) {
      throw new Error(`blob_size_mismatch:${f.path}`);
    }
    map.set(f.path, buf);
    done++;
    bytesDone += buf.length;
    await onProgress(done, bytesDone);
  }
  return map;
}

/**
 * Apply one OTA job if present. Returns:
 * - `null` if no job
 * - `"applied"` if files written and caller should restart
 * - `"noop"` if already on version / skipped
 * - `"failed"` if error recorded
 */
export async function tryApplyOtaUpdate(
  opts: OtaApplyOptions,
): Promise<"applied" | "noop" | "failed" | null> {
  const job = await getWorkerUpdateJob(opts.db, opts.workerId);
  if (!job) return null;

  return applyOtaJob(opts, job);
}

export async function applyOtaJob(
  opts: OtaApplyOptions,
  job: NodeUpdateJob,
): Promise<"applied" | "noop" | "failed"> {
  const log = opts.log;
  const workerId = opts.workerId;
  const now = () => new Date().toISOString();

  const patchStatus = async (
    phase: NodeUpdateStatus["phase"],
    extra?: Partial<NodeUpdateStatus>,
  ) => {
    const st: NodeUpdateStatus = {
      workerId,
      version: job.version,
      phase,
      error: null,
      startedAt: extra?.startedAt ?? now(),
      updatedAt: now(),
      progress: extra?.progress,
      changedFiles: extra?.changedFiles,
      message: extra?.message ?? null,
    };
    await setWorkerUpdateStatus(opts.db, st);
  };

  try {
    // Idempotent: already running this version
    if (!job.force && opts.appVersion === job.version) {
      await patchStatus("done", {
        startedAt: now(),
        message: "already_on_version",
        progress: { done: 0, total: 0 },
      });
      await clearWorkerUpdateJob(opts.db, workerId);
      log?.(`[ota] skip already on version ${job.version}`);
      return "noop";
    }

    const release =
      (await getReleaseMeta(opts.db, job.version)) ?? null;
    if (!release) {
      throw new Error("release_not_found");
    }

    await patchStatus("downloading", {
      startedAt: now(),
      message: "scanning_local",
      progress: { done: 0, total: 0 },
    });

    const local = scanLocalOtaHashes(opts.repoRoot);
    const needed = diffReleaseFiles(release, local);
    const bytesTotal = needed.reduce((a, f) => a + f.size, 0);

    log?.(
      `[ota] update ${opts.appVersion} → ${job.version}: ${needed.length}/${release.fileCount} file(s) changed (${bytesTotal} bytes)`,
    );

    await patchStatus("downloading", {
      startedAt: now(),
      message: "downloading",
      changedFiles: needed.length,
      progress: {
        done: 0,
        total: needed.length,
        bytesDone: 0,
        bytesTotal,
      },
    });

    const blobs =
      needed.length === 0
        ? new Map<string, Buffer>()
        : await downloadNeeded(
            opts.db,
            needed,
            async (done, bytesDone) => {
              await patchStatus("downloading", {
                startedAt: now(),
                message: "downloading",
                changedFiles: needed.length,
                progress: {
                  done,
                  total: needed.length,
                  bytesDone,
                  bytesTotal,
                },
              });
            },
          );

    await patchStatus("applying", {
      startedAt: now(),
      message: "staging",
      changedFiles: needed.length,
      progress: {
        done: 0,
        total: needed.length,
        bytesDone: bytesTotal,
        bytesTotal,
      },
    });

    const staging = resolveStagingAbs(opts.repoRoot, opts.stagingDir);
    // clean staging
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const root = path.resolve(opts.repoRoot);
    const backupRoot = path.join(root, ".wa-backup", job.version);
    fs.rmSync(backupRoot, { recursive: true, force: true });

    let applied = 0;
    for (const f of needed) {
      const n = normalizeOtaPath(f.path);
      if (!n || !isAllowedOtaPath(n)) {
        throw new Error(`path_not_allowed:${f.path}`);
      }
      const data = blobs.get(f.path);
      if (!data) throw new Error(`blob_missing:${f.path}`);
      const stageAbs = path.join(staging, ...n.split("/"));
      safeWriteFile(stageAbs, data);
      applied++;
      if (applied % 20 === 0 || applied === needed.length) {
        await patchStatus("applying", {
          startedAt: now(),
          message: "staging",
          changedFiles: needed.length,
          progress: {
            done: applied,
            total: needed.length,
            bytesDone: bytesTotal,
            bytesTotal,
          },
        });
      }
    }

    // Atomic swap: backup then replace
    for (const f of needed) {
      const n = f.path;
      const dest = path.join(root, ...n.split("/"));
      const stageAbs = path.join(staging, ...n.split("/"));
      if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
        const bak = path.join(backupRoot, ...n.split("/"));
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        try {
          fs.copyFileSync(dest, bak);
        } catch {
          /* best effort backup */
        }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(stageAbs, dest);
    }

    // Write version stamp (read before APP_VERSION env on next boot)
    safeWriteFile(
      path.join(root, ".wa-version"),
      Buffer.from(`${job.version}\n`, "utf8"),
    );

    // Full-tree files not in local but in release that weren't "needed" are same hash — OK.
    // Files only local extra: leave in place (no delete of unknown files for safety).

    if (release.requiresInstall || needsInstallFromNeeded(needed, release)) {
      if (!opts.allowInstall) {
        throw new Error("install_required_but_ota_allow_install_false");
      }
      await patchStatus("installing", {
        startedAt: now(),
        message: "pnpm_install",
        changedFiles: needed.length,
        progress: {
          done: needed.length,
          total: needed.length,
          bytesDone: bytesTotal,
          bytesTotal,
        },
      });
      log?.(`[ota] running pnpm install --frozen-lockfile`);
      await runPnpmInstall(root, log);
    }

    await patchStatus("restarting", {
      startedAt: now(),
      message: "restarting",
      changedFiles: needed.length,
      progress: {
        done: needed.length,
        total: needed.length,
        bytesDone: bytesTotal,
        bytesTotal,
      },
    });

    // Clear job so reboot doesn't re-apply immediately
    await clearWorkerUpdateJob(opts.db, workerId);

    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* */
    }

    log?.(`[ota] applied ${job.version}, restarting process`);
    await opts.beforeRestart?.();
    return "applied";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`[ota] failed: ${message}`);
    try {
      await setWorkerUpdateStatus(opts.db, {
        workerId,
        version: job.version,
        phase: "failed",
        error: message.slice(0, 500),
        startedAt: now(),
        updatedAt: now(),
        message: "failed",
      });
    } catch {
      /* */
    }
    try {
      await clearWorkerUpdateJob(opts.db, workerId);
    } catch {
      /* allow retry via new enqueue */
    }
    return "failed";
  }
}

function needsInstallFromNeeded(
  needed: ReleaseFileEntry[],
  release: ReleaseMeta,
): boolean {
  if (release.requiresInstall) {
    // only if install-related files actually changed
    return needed.some((f) =>
      /package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$/.test(f.path),
    );
  }
  return false;
}
