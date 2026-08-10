/**
 * OTA path whitelist / validation shared by pack CLI and node apply.
 * Paths are POSIX-style relative to monorepo root (no leading slash).
 */

/** Exact root files included in a release pack. */
export const OTA_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
] as const;

/** Directory prefixes allowed (recursive). */
export const OTA_DIR_PREFIXES = [
  "apps/api/",
  "packages/core/",
  "packages/db/",
  "packages/ilink/",
  "packages/llm/",
  "scripts/",
] as const;

const DENY_SEGMENT = new Set([
  "node_modules",
  "data",
  ".git",
  ".wa-update-staging",
  ".wa-backup",
  "dist",
  "coverage",
]);

const DENY_BASENAME = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".ds_store",
]);

const DENY_EXT = new Set([".db", ".db-wal", ".db-shm", ".log", ".bak"]);

/** Files that force requiresInstall when present in the changed set. */
export const OTA_INSTALL_TRIGGER_FILES = new Set([
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "apps/api/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/ilink/package.json",
  "packages/llm/package.json",
]);

/**
 * Normalize to POSIX relative path without leading `./` or `/`.
 * Returns null if path escapes or is empty.
 */
export function normalizeOtaPath(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  let p = input.replace(/\\/g, "/").trim();
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  // collapse ./ and //
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  if (!parts.length) return null;
  return parts.join("/");
}

export function isDeniedOtaPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = lower.split("/").pop() || "";
  if (DENY_BASENAME.has(base)) return true;
  if (base.startsWith(".env")) return true;
  for (const ext of DENY_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  const segs = lower.split("/");
  for (const s of segs) {
    if (DENY_SEGMENT.has(s)) return true;
  }
  return false;
}

/**
 * Whether a normalized relative path may appear in an OTA pack / be written.
 */
export function isAllowedOtaPath(relPath: string): boolean {
  const n = normalizeOtaPath(relPath);
  if (!n) return false;
  if (isDeniedOtaPath(n)) return false;

  if ((OTA_ROOT_FILES as readonly string[]).includes(n)) return true;

  for (const prefix of OTA_DIR_PREFIXES) {
    if (!n.startsWith(prefix)) continue;
    // packages/* : only package.json, tsconfig.json, and src/**
    if (prefix.startsWith("packages/")) {
      const rest = n.slice(prefix.length);
      if (rest === "package.json" || rest === "tsconfig.json") return true;
      if (rest.startsWith("src/")) return true;
      return false;
    }
    // apps/api and scripts: all non-denied files under prefix
    return true;
  }
  return false;
}

export function pathRequiresInstall(relPath: string): boolean {
  const n = normalizeOtaPath(relPath);
  if (!n) return false;
  return OTA_INSTALL_TRIGGER_FILES.has(n);
}

/** Validate version string for release ids (semver-ish or freeform label). */
export function isValidReleaseVersion(v: string): boolean {
  if (!v || v.length > 64) return false;
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(v);
}
