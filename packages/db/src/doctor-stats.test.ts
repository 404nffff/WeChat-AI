import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DEEP_STATS_MAX_PEERS,
  assignmentKeys,
  deepStatsMaxPeers,
  memoryKeys,
  messageKeys,
  pairKey,
  parsePeerPairs,
  shouldComputeDeepStats,
} from "./doctor-stats.js";

describe("parsePeerPairs", () => {
  it("splits botId|peerId", () => {
    assert.deepEqual(parsePeerPairs(["b1|p1", "b2|p2"]), [
      { botId: "b1", peerId: "p1" },
      { botId: "b2", peerId: "p2" },
    ]);
  });

  it("splits on the first separator only, since peerId is opaque", () => {
    assert.deepEqual(parsePeerPairs(["bot|wx|abc|def"]), [
      { botId: "bot", peerId: "wx|abc|def" },
    ]);
  });

  it("drops malformed members instead of producing partial keys", () => {
    assert.deepEqual(parsePeerPairs(["", "nosep", "|p", "b|", "b|p"]), [
      { botId: "b", peerId: "p" },
    ]);
  });

  it("handles an empty set", () => {
    assert.deepEqual(parsePeerPairs([]), []);
  });
});

describe("key planning", () => {
  const pairs = [
    { botId: "b1", peerId: "p1" },
    { botId: "b2", peerId: "p2" },
  ];

  it("builds assignment keys aligned with the pair order", () => {
    assert.deepEqual(assignmentKeys(pairs), [
      "wa:asg:b1:p1",
      "wa:asg:b2:p2",
    ]);
  });

  it("builds message keys aligned with the pair order", () => {
    assert.deepEqual(messageKeys(pairs), [
      "wa:msgs:b1:p1",
      "wa:msgs:b2:p2",
    ]);
  });

  it("pairKey matches the assignment map convention", () => {
    assert.equal(pairKey(pairs[0]!), "b1|p1");
  });
});

describe("memoryKeys", () => {
  const pairs = [
    { botId: "b1", peerId: "p1" },
    { botId: "b1", peerId: "p2" },
  ];

  it("uses the assigned persona when there is one", () => {
    const assigned = new Map([["b1|p1", "persona-x"]]);
    assert.deepEqual(memoryKeys(pairs, assigned, null), [
      "wa:mem:b1:p1:persona-x",
    ]);
  });

  it("falls back to the platform default for unassigned peers", () => {
    assert.deepEqual(memoryKeys(pairs, new Map(), "persona-def"), [
      "wa:mem:b1:p1:persona-def",
      "wa:mem:b1:p2:persona-def",
    ]);
  });

  it("counts both assigned and default when they differ", () => {
    const assigned = new Map([["b1|p1", "persona-x"]]);
    assert.deepEqual(memoryKeys(pairs, assigned, "persona-def"), [
      "wa:mem:b1:p1:persona-x",
      "wa:mem:b1:p1:persona-def",
      "wa:mem:b1:p2:persona-def",
    ]);
  });

  it("never emits the same key twice when assignment equals the default", () => {
    const assigned = new Map([["b1|p1", "persona-def"]]);
    const keys = memoryKeys(pairs, assigned, "persona-def");
    assert.deepEqual(keys, [
      "wa:mem:b1:p1:persona-def",
      "wa:mem:b1:p2:persona-def",
    ]);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("stays at most two keys per peer", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      botId: "b",
      peerId: `p${i}`,
    }));
    const assigned = new Map(many.map((p) => [pairKey(p), `persona-${p.peerId}`]));
    assert.equal(memoryKeys(many, assigned, "persona-def").length, 100);
  });

  it("produces nothing when there is neither an assignment nor a default", () => {
    assert.deepEqual(memoryKeys(pairs, new Map(), null), []);
  });
});

describe("deep stat sizing", () => {
  it("defaults the cap when unset or unparseable", () => {
    assert.equal(deepStatsMaxPeers({}), DEFAULT_DEEP_STATS_MAX_PEERS);
    assert.equal(
      deepStatsMaxPeers({ DOCTOR_DEEP_STATS_MAX_PEERS: "abc" }),
      DEFAULT_DEEP_STATS_MAX_PEERS,
    );
  });

  it("reads an explicit cap", () => {
    assert.equal(deepStatsMaxPeers({ DOCTOR_DEEP_STATS_MAX_PEERS: "120" }), 120);
  });

  it("treats 0 and negatives as disabled", () => {
    assert.equal(deepStatsMaxPeers({ DOCTOR_DEEP_STATS_MAX_PEERS: "0" }), 0);
    assert.equal(deepStatsMaxPeers({ DOCTOR_DEEP_STATS_MAX_PEERS: "-5" }), 0);
    assert.equal(shouldComputeDeepStats(0, 0), false);
    assert.equal(shouldComputeDeepStats(1, 0), false);
  });

  it("computes at or below the cap and skips above it", () => {
    assert.equal(shouldComputeDeepStats(0, 10), true);
    assert.equal(shouldComputeDeepStats(10, 10), true);
    assert.equal(shouldComputeDeepStats(11, 10), false);
  });
});
