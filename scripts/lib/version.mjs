/**
 * Shared root package.json version helpers for release-pack / docker-build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const rootPkgPath = path.join(repoRoot, "package.json");

/**
 * Bump semver core (major.minor.patch). Prerelease/build metadata is dropped.
 * @param {string} version
 * @param {"patch"|"minor"|"major"|"none"} level
 */
export function bumpSemver(version, level) {
  const m = String(version || "0.0.0")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) {
    throw new Error(
      `cannot bump non-semver version "${version}" (use --version X)`,
    );
  }
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else if (level === "patch") {
    patch += 1;
  } else if (level !== "none") {
    throw new Error(`unknown bump level: ${level}`);
  }
  return `${major}.${minor}.${patch}`;
}

export function readRootPackage() {
  return JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
}

export function writeRootPackageVersion(pkg, version) {
  const next = { ...pkg, version };
  const raw = fs.readFileSync(rootPkgPath, "utf8");
  const replaced = raw.replace(
    /("version"\s*:\s*")([^"]*)(")/,
    `$1${version}$3`,
  );
  if (replaced !== raw && /"version"\s*:/.test(raw)) {
    fs.writeFileSync(rootPkgPath, replaced);
  } else {
    fs.writeFileSync(rootPkgPath, `${JSON.stringify(next, null, 2)}\n`);
  }
}

/**
 * Resolve next version and optionally write root package.json.
 * @param {{ version?: string|null, bump?: string, write?: boolean, log?: (s: string) => void }} opts
 * @returns {{ prevVersion: string, version: string, wrote: boolean }}
 */
export function applyRootVersion(opts = {}) {
  const bump = opts.bump ?? "patch";
  const write = opts.write !== false;
  const log = opts.log ?? console.log;
  const pkg = readRootPackage();
  const prevVersion = String(pkg.version || "0.0.0");

  let version = opts.version ? String(opts.version).trim() : null;
  if (!version) {
    if (bump === "none") version = prevVersion;
    else version = bumpSemver(prevVersion, bump);
  }

  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }

  let wrote = false;
  if (write && version !== prevVersion) {
    writeRootPackageVersion(pkg, version);
    wrote = true;
    log(`version ${prevVersion} → ${version} (wrote package.json)`);
  } else if (version === prevVersion) {
    log(`version ${version} (unchanged)`);
  } else {
    log(
      `version ${prevVersion} → ${version} (not written to package.json)`,
    );
  }

  return { prevVersion, version, wrote };
}

/**
 * Parse common version flags from argv slice (mutates by consuming).
 * Shared by release-pack / docker-build.
 * @param {string[]} argv full process.argv
 * @param {number} start index to start (default 2)
 * @returns {{ version: string|null, bump: string, write: boolean, rest: string[], help: boolean }}
 */
export function parseVersionArgs(argv, start = 2) {
  const out = {
    version: null,
    bump: "patch",
    write: true,
    rest: [],
    help: false,
  };
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") {
      out.version = argv[++i];
      out.bump = "none";
    } else if (a === "--bump") {
      const level = String(argv[++i] || "")
        .trim()
        .toLowerCase();
      if (!["patch", "minor", "major", "none"].includes(level)) {
        throw new Error(
          `invalid --bump (use patch|minor|major|none): ${level}`,
        );
      }
      out.bump = level;
    } else if (a === "--no-bump") {
      out.bump = "none";
    } else if (a === "--no-write") {
      out.write = false;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--") {
      // End-of-options marker. pnpm forwards its own `--` into argv, so
      // `pnpm release:pack -- --bump minor` would otherwise fail with
      // "unknown argument: --".
    } else {
      out.rest.push(a);
    }
  }
  return out;
}
