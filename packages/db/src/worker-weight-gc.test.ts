import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { K } from "./keys.js";
import {
  DEFAULT_WORKER_WEIGHT_TTL_SEC,
  gcWorkerWeights,
  listWorkerWeights,
  listWorkerWeightSeen,
  pruneWorkerWeights,
  type WorkerWeight,
} from "./worker-fleet.js";
import type { RedisStore } from "./client.js";

/**
 * Minimal in-memory stand-in for the bits of RedisStore the GC touches:
 * the weights hash, per-node heartbeat meta keys, and the fenced set.
 */
function fakeDb(opts: {
  weights: Record<string, WorkerWeight>;
  /** workerId → ISO last-seen, the separate wa:workers:weights:seen hash */
  seen?: Record<string, string>;
  /** Worker ids whose heartbeat meta key still exists */
  live: string[];
  fenced?: string[];
}) {
  const hashes: Record<string, Record<string, string>> = {
    [K.workerWeights]: {},
    [K.workerWeightsSeen]: { ...(opts.seen ?? {}) },
  };
  for (const [id, w] of Object.entries(opts.weights)) {
    hashes[K.workerWeights]![id] = JSON.stringify(w);
  }
  const live = new Set(opts.live);
  const fenced = new Set(opts.fenced ?? []);
  const calls: string[] = [];
  const writes: Array<[string, string, string]> = [];

  const hdel = (key: string, fields: string[]) => {
    const h = hashes[key];
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (f in h) {
        delete h[f];
        n++;
      }
    }
    return n;
  };

  const db = {
    redis: {
      async hgetall(key: string) {
        calls.push(`hgetall ${key}`);
        return { ...(hashes[key] ?? {}) };
      },
      hdel(key: string, ...fields: string[]) {
        calls.push(`hdel ${key} ${fields.join(",")}`);
        return Promise.resolve(hdel(key, fields));
      },
      async smembers(key: string) {
        calls.push(`smembers ${key}`);
        return key === K.workersFenced ? [...fenced] : [];
      },
      pipeline() {
        const staged: Array<() => unknown> = [];
        const api = {
          hset(key: string, field: string, value: string) {
            staged.push(() => {
              (hashes[key] ??= {})[field] = value;
              writes.push([key, field, value]);
              return "OK";
            });
            return api;
          },
          hdel(key: string, ...fields: string[]) {
            staged.push(() => hdel(key, fields));
            return api;
          },
          async exec() {
            return staged.map((fn) => [null, fn()]);
          },
        };
        return api;
      },
    },
    async existsMany(keys: string[]) {
      calls.push(`existsMany ${keys.length}`);
      return keys.map((k) => live.has(k.replace(/^wa:worker:/, "")));
    },
  } as unknown as RedisStore;

  return {
    db,
    calls,
    writes,
    hash: hashes[K.workerWeights]!,
    seenHash: hashes[K.workerWeightsSeen]!,
  };
}

function weight(workerId: string, percent: number): WorkerWeight {
  return {
    workerId,
    percent,
    updatedAt: "2026-01-01T00:00:00.000Z",
    byUserId: null,
    byUsername: null,
  };
}

const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

describe("gcWorkerWeights", () => {
  it("does nothing when no weights are set", async () => {
    const { db, calls } = fakeDb({ weights: {}, live: [] });
    const r = await gcWorkerWeights(db, { now: NOW });
    assert.deepEqual(r, { removed: [], touched: [], pending: 0 });
    // No liveness or fence reads when the hash is empty
    assert.ok(!calls.some((c) => c.startsWith("existsMany")));
  });

  it("deletes a weight once its node has been gone past the grace period", async () => {
    const { db, hash, seenHash } = fakeDb({
      weights: { dead: weight("dead", 300) },
      seen: { dead: ago(7200) },
      live: [],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, ["dead"]);
    assert.equal("dead" in hash, false);
    assert.equal("dead" in seenHash, false, "timestamp must go too");
  });

  it("keeps a weight while the node is only briefly gone (restart / OTA)", async () => {
    const { db, hash } = fakeDb({
      weights: { restarting: weight("restarting", 300) },
      seen: { restarting: ago(120) },
      live: [],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, []);
    assert.equal(r.pending, 1);
    assert.ok("restarting" in hash);
  });

  it("never expires a fenced node's weight", async () => {
    const { db, hash } = fakeDb({
      weights: { fencedNode: weight("fencedNode", 0) },
      seen: { fencedNode: ago(999999) },
      live: [],
      fenced: ["fencedNode"],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, []);
    assert.ok("fencedNode" in hash);
  });

  it("refreshes the timestamp for a live node so it never expires", async () => {
    const { db, hash, seenHash } = fakeDb({
      weights: { alive: weight("alive", 200) },
      seen: { alive: ago(5000) },
      live: ["alive"],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.touched, ["alive"]);
    assert.equal(seenHash.alive, new Date(NOW).toISOString());
    const stored = JSON.parse(hash.alive!) as WorkerWeight;
    assert.equal(stored.percent, 200, "the weight itself must not change");
  });

  it("never rewrites the weight record, so a concurrent admin edit survives", async () => {
    const { db, writes } = fakeDb({
      weights: { alive: weight("alive", 200) },
      seen: { alive: ago(5000) },
      live: ["alive"],
    });
    await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.ok(writes.length > 0, "expected a timestamp write");
    assert.equal(
      writes.every(([key]) => key === K.workerWeightsSeen),
      true,
      `GC wrote outside the seen hash: ${JSON.stringify(writes)}`,
    );
  });

  it("does not rewrite a live node whose timestamp is still fresh", async () => {
    const { db, writes } = fakeDb({
      weights: { alive: weight("alive", 200) },
      seen: { alive: ago(60) },
      live: ["alive"],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.touched, []);
    assert.equal(writes.length, 0);
  });

  it("keeps a live node's weight even if its timestamp is ancient (mixed-version fleet)", async () => {
    // Liveness comes from the heartbeat meta key, which every build writes, so
    // a node on an older image is refreshed rather than deleted.
    const { db, hash } = fakeDb({
      weights: { oldBuild: weight("oldBuild", 250) },
      seen: { oldBuild: ago(999999) },
      live: ["oldBuild"],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.touched, ["oldBuild"]);
    assert.ok("oldBuild" in hash);
  });

  it("handles a mixed fleet in one pass", async () => {
    const { db, hash } = fakeDb({
      weights: {
        alive: weight("alive", 200),
        restarting: weight("restarting", 150),
        dead: weight("dead", 50),
        fencedNode: weight("fencedNode", 0),
      },
      seen: {
        alive: ago(5000),
        restarting: ago(120),
        dead: ago(7200),
        fencedNode: ago(7200),
      },
      live: ["alive"],
      fenced: ["fencedNode"],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, ["dead"]);
    assert.deepEqual(r.touched, ["alive"]);
    assert.equal(r.pending, 1);
    assert.deepEqual(Object.keys(hash).sort(), [
      "alive",
      "fencedNode",
      "restarting",
    ]);
  });

  it("treats an unparseable timestamp as expired", async () => {
    const { db, hash } = fakeDb({
      weights: {
        broken: {
          workerId: "broken",
          percent: 300,
          updatedAt: "not-a-date",
          byUserId: null,
          byUsername: null,
        },
      },
      seen: { broken: "also-not-a-date" },
      live: [],
    });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, ["broken"]);
    assert.equal("broken" in hash, false);
  });

  it("falls back to updatedAt when no timestamp was recorded", async () => {
    const legacy: WorkerWeight = {
      workerId: "legacy",
      percent: 300,
      updatedAt: ago(7200),
      byUserId: null,
      byUsername: null,
    };
    const { db } = fakeDb({ weights: { legacy }, live: [] });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, ["legacy"]);
  });

  it("keeps a just-set weight for a node that has never been online", async () => {
    const fresh: WorkerWeight = {
      workerId: "notYet",
      percent: 300,
      updatedAt: ago(30),
      byUserId: null,
      byUsername: null,
    };
    const { db } = fakeDb({ weights: { notYet: fresh }, live: [] });
    const r = await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(r.removed, []);
    assert.equal(r.pending, 1);
  });

  it("drops orphaned timestamps whose weight was cleared elsewhere", async () => {
    const { db, seenHash } = fakeDb({
      weights: { alive: weight("alive", 200) },
      seen: { alive: ago(60), ghost: ago(60) },
      live: ["alive"],
    });
    await gcWorkerWeights(db, { graceSec: 3600, now: NOW });
    assert.deepEqual(Object.keys(seenHash), ["alive"]);
  });

  it("force ignores the grace period but still spares live and fenced nodes", async () => {
    const { db, hash } = fakeDb({
      weights: {
        alive: weight("alive", 200),
        justGone: weight("justGone", 150),
        fencedNode: weight("fencedNode", 0),
      },
      seen: { alive: ago(10), justGone: ago(5), fencedNode: ago(5) },
      live: ["alive"],
      fenced: ["fencedNode"],
    });
    const r = await gcWorkerWeights(db, { force: true, now: NOW });
    assert.deepEqual(r.removed, ["justGone"]);
    assert.deepEqual(Object.keys(hash).sort(), ["alive", "fencedNode"]);
  });

  it("pruneWorkerWeights removes absent nodes without waiting", async () => {
    const { db } = fakeDb({
      weights: {
        alive: weight("alive", 200),
        justGone: weight("justGone", 150),
      },
      seen: { alive: ago(10), justGone: ago(5) },
      live: ["alive"],
    });
    assert.deepEqual(await pruneWorkerWeights(db), ["justGone"]);
  });

  it("clamps an absurdly small grace period instead of expiring everything", async () => {
    const { db } = fakeDb({
      weights: { recent: weight("recent", 300) },
      seen: { recent: ago(30) },
      live: [],
    });
    const r = await gcWorkerWeights(db, { graceSec: 0, now: NOW });
    // graceSec floors at 60s, so a node gone 30s is still pending
    assert.deepEqual(r.removed, []);
    assert.equal(r.pending, 1);
  });

  it("uses a sane default grace period", () => {
    assert.equal(DEFAULT_WORKER_WEIGHT_TTL_SEC, 3600);
  });
});

describe("weight reads surface Redis failures", () => {
  function failingDb(failOn: string) {
    return {
      redis: {
        async hgetall(key: string) {
          if (key === failOn) throw new Error("ECONNRESET");
          return {};
        },
        async smembers() {
          return [];
        },
        pipeline() {
          const api = {
            hset: () => api,
            hdel: () => api,
            async exec() {
              return [];
            },
          };
          return api;
        },
        async hdel() {
          return 0;
        },
      },
      async existsMany(keys: string[]) {
        return keys.map(() => false);
      },
    } as unknown as RedisStore;
  }

  it("listWorkerWeights rejects instead of reporting 'no overrides'", async () => {
    // An empty object is a real instruction (nothing is weighted). Returning
    // it for a failed read would silently un-drain a 0% node.
    await assert.rejects(
      () => listWorkerWeights(failingDb(K.workerWeights)),
      /ECONNRESET/,
    );
  });

  it("listWorkerWeightSeen rejects instead of reporting 'never seen'", async () => {
    await assert.rejects(
      () => listWorkerWeightSeen(failingDb(K.workerWeightsSeen)),
      /ECONNRESET/,
    );
  });

  it("gcWorkerWeights aborts rather than expiring nodes on a failed read", async () => {
    // The GC deletes based on these timestamps; a partial read must not be
    // mistaken for "this node was never seen".
    await assert.rejects(
      () =>
        gcWorkerWeights(failingDb(K.workerWeightsSeen), {
          weights: { dead: weight("dead", 300) },
          graceSec: 3600,
          now: NOW,
        }),
      /ECONNRESET/,
    );
  });
});
