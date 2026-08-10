/**
 * Bump root package.json, pack OTA channel artifact, then Docker build.
 *
 * Default: pack only. Super-admin publishes via
 * /admin → 部署节点 →「上传通道包」(files.json), then「更新」nodes.
 *
 *   pnpm docker:build
 *   pnpm docker:up
 *   node scripts/docker-build.mjs -- docker build -t your-dockerhub-user/wechat-ai:latest .
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  applyRootVersion,
  parseVersionArgs,
  repoRoot,
} from "./lib/version.mjs";

function printHelp() {
  console.log(`Usage: node scripts/docker-build.mjs [opts] [mode] [-- docker args...]

Version:
  (default)           bump patch on root package.json
  --bump patch|minor|major|none
  --no-bump
  --version X
  --no-write

OTA channel pack (default: pack → dist/release/<ver>/files.json):
  --no-channel        skip pack

Publish channel in browser (no CLI cookie):
  /admin → 部署节点 → 上传通道包 → 选择 files.json → 更新节点

Mode:
  (default)           docker compose build
  --up                docker compose up -d --build
  --raw               docker build -t wechat-ai .
  -- <cmd...>         custom command after bump/pack

Examples:
  pnpm docker:build -- --bump minor -- docker build -t your-dockerhub-user/wechat-ai:latest .
  pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
  pnpm docker:build -- --no-channel -- docker build -t wechat-ai .

Note: everything after the FIRST \`--\` goes to pnpm; script flags such as
--bump/--no-channel come next, then a second \`--\` before a custom command.
`);
}

/**
 * Split `[opts] -- <cmd...>`.
 *
 * pnpm forwards its own `--` separator into argv, so
 * `pnpm docker:build -- --bump minor -- docker build .` arrives here as
 * ["--", "--bump", "minor", "--", "docker", ...]. A real passthrough command
 * always starts with an executable name, never with `-`, so a leading `--`
 * followed by a flag is pnpm's artifact and is dropped. That leaves
 * `node scripts/docker-build.mjs -- docker build .` parsed as before.
 */
function splitPassthrough(argv) {
  const args = argv.slice(2);
  while (args[0] === "--" && args[1] && args[1].startsWith("-")) args.shift();
  const idx = args.indexOf("--");
  if (idx === -1) return { head: args, tail: [] };
  const head = args.slice(0, idx);
  const tail = args.slice(idx + 1);
  // `-- <flags> -- -- docker build .` leaves an extra separator in front of the
  // command; a command never starts with `--`, so drop them.
  while (tail[0] === "--") tail.shift();
  return { head, tail };
}

function runNodeScript(scriptRel, args) {
  const script = path.join(repoRoot, "scripts", scriptRel);
  console.log(`$ node ${scriptRel} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    cwd: repoRoot,
    env: process.env,
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
}

function peelDockerBuildFlags(head) {
  const out = {
    mode: "compose-build",
    pack: true,
    rest: [],
  };
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--up") out.mode = "compose-up";
    else if (a === "--raw") out.mode = "raw";
    else if (a === "--build-only") out.mode = "compose-build";
    else if (a === "--no-channel" || a === "--skip-channel") out.pack = false;
    else if (a === "--pack-only") out.pack = true;
    // Reject removed CLI push flags with a clear message
    else if (
      a === "--push" ||
      a === "--cookie" ||
      a === "-c" ||
      a === "--base" ||
      a === "-b" ||
      a === "--no-current"
    ) {
      console.error(
        `Removed flag: ${a}\n` +
          "Channel publish is web-only: /admin → 部署节点 → 上传通道包 (files.json).\n" +
          "Do not use WA_SESSION_COOKIE / --cookie / --push.",
      );
      process.exit(1);
    } else out.rest.push(a);
  }
  return out;
}

function main() {
  const { head, tail } = splitPassthrough(process.argv);
  const peeled = peelDockerBuildFlags(head);

  let parsed;
  try {
    parsed = parseVersionArgs(["node", "docker-build", ...peeled.rest], 2);
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const forward = parsed.rest;

  let version;
  try {
    ({ version } = applyRootVersion({
      version: parsed.version,
      bump: parsed.bump,
      write: parsed.write,
    }));
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }

  if (peeled.pack) {
    runNodeScript("release-pack.mjs", ["--no-bump"]);
    const filesJson = path.join(
      repoRoot,
      "dist",
      "release",
      version,
      "files.json",
    );
    console.log(`[channel] packed → ${filesJson}`);
    console.log(
      `[channel] next: /admin → 部署节点 → 上传通道包 → 选择 files.json → 更新节点`,
    );
  } else {
    console.log("[channel] skipped (--no-channel)");
  }

  /** @type {string[]} */
  let cmd;
  let mode = peeled.mode;
  if (tail.length > 0) {
    cmd = tail;
    mode = "custom";
  } else if (mode === "compose-up") {
    cmd = ["docker", "compose", "up", "-d", "--build", ...forward];
  } else if (mode === "raw") {
    cmd = ["docker", "build", "-t", "wechat-ai", ".", ...forward];
  } else {
    cmd = ["docker", "compose", "build", ...forward];
  }

  console.log(`$ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
    cwd: repoRoot,
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

main();
