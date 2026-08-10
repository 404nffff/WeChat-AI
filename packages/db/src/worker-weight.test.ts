import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKER_WEIGHT,
  MAX_WORKER_WEIGHT,
  annotateTargetShares,
  computeWeightedShedCount,
  computeWeightedTargets,
  planNodeLoad,
  shedAboveTarget,
  hasWorkerWeightOverrides,
  normalizeWorkerWeight,
  parseWorkerWeightInput,
  weightedShare,
  type FleetNodeView,
  type WorkerWeight,
} from "./worker-fleet.js";

function node(
  id: string,
  over: Partial<FleetNodeView> = {},
): FleetNodeView {
  return {
    id,
    hostname: id,
    pid: 1,
    maxBots: 500,
    botCount: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    role: "all",
    leasedBotIds: [],
    leasedCount: 0,
    isSelf: false,
    online: true,
    fenced: false,
    weight: DEFAULT_WORKER_WEIGHT,
    weightOverride: false,
    targetShare: null,
    ...over,
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

describe("normalizeWorkerWeight", () => {
  it("defaults when not a number", () => {
    assert.equal(normalizeWorkerWeight(undefined), DEFAULT_WORKER_WEIGHT);
    assert.equal(normalizeWorkerWeight("abc"), DEFAULT_WORKER_WEIGHT);
    assert.equal(normalizeWorkerWeight(NaN), DEFAULT_WORKER_WEIGHT);
  });

  it("clamps to the supported range and rounds", () => {
    assert.equal(normalizeWorkerWeight(-40), 0);
    assert.equal(normalizeWorkerWeight(10_000), MAX_WORKER_WEIGHT);
    assert.equal(normalizeWorkerWeight("150"), 150);
    assert.equal(normalizeWorkerWeight(72.6), 73);
  });
});

describe("parseWorkerWeightInput", () => {
  it("accepts numbers and numeric strings", () => {
    assert.deepEqual(parseWorkerWeightInput(0), { ok: true, value: 0 });
    assert.deepEqual(parseWorkerWeightInput(250), { ok: true, value: 250 });
    assert.deepEqual(parseWorkerWeightInput("150"), { ok: true, value: 150 });
    assert.deepEqual(parseWorkerWeightInput(" 150 "), { ok: true, value: 150 });
    assert.deepEqual(parseWorkerWeightInput(72.6), { ok: true, value: 73 });
  });

  it("rejects values Number() would silently turn into 0 (a full drain)", () => {
    // Number(" ") === 0, Number([]) === 0, Number(false) === 0 — none of these
    // may be read as "drain this node".
    for (const bad of [" ", "\t\n", [], false, true, {}, "abc", "12abc", ""]) {
      const r = parseWorkerWeightInput(bad);
      assert.equal(
        r.ok,
        false,
        `${JSON.stringify(bad)} must be rejected, got ${JSON.stringify(r)}`,
      );
    }
  });

  it("rejects a missing value", () => {
    assert.deepEqual(parseWorkerWeightInput(undefined), {
      ok: false,
      error: "weight_required",
    });
    assert.deepEqual(parseWorkerWeightInput(null), {
      ok: false,
      error: "weight_required",
    });
  });

  it("rejects out-of-range instead of clamping, so the caller is told", () => {
    assert.deepEqual(parseWorkerWeightInput(-1), {
      ok: false,
      error: "weight_out_of_range",
    });
    assert.deepEqual(parseWorkerWeightInput(501), {
      ok: false,
      error: "weight_out_of_range",
    });
    assert.deepEqual(parseWorkerWeightInput("9999"), {
      ok: false,
      error: "weight_out_of_range",
    });
  });

  it("rejects NaN and Infinity", () => {
    assert.equal(parseWorkerWeightInput(NaN).ok, false);
    assert.equal(parseWorkerWeightInput(Infinity).ok, false);
    assert.equal(parseWorkerWeightInput(-Infinity).ok, false);
  });
});

describe("hasWorkerWeightOverrides", () => {
  it("ignores entries that are still the default", () => {
    assert.equal(hasWorkerWeightOverrides({}), false);
    assert.equal(
      hasWorkerWeightOverrides({ a: weight("a", DEFAULT_WORKER_WEIGHT) }),
      false,
    );
    assert.equal(hasWorkerWeightOverrides({ a: weight("a", 0) }), true);
    assert.equal(hasWorkerWeightOverrides({ a: weight("a", 250) }), true);
  });
});

describe("weightedShare", () => {
  it("splits by weight", () => {
    assert.equal(weightedShare(300, 200, 300, 2), 200);
    assert.equal(weightedShare(300, 100, 300, 2), 100);
  });

  it("falls back to an even split when every weight is zero", () => {
    assert.equal(weightedShare(300, 0, 0, 3), 100);
  });

  it("is zero for an empty fleet total", () => {
    assert.equal(weightedShare(0, 100, 200, 2), 0);
  });
});

describe("computeWeightedShedCount", () => {
  it("matches the even split when nothing is weighted", () => {
    // total 100 over 2 nodes → fair 50, slack 2 → shed 8
    assert.equal(
      computeWeightedShedCount({
        localCount: 60,
        peers: [{ count: 40 }],
        slack: 2,
        maxPerTick: 100,
      }),
      8,
    );
  });

  it("lets a boosted peer pull work away", () => {
    // total 100, local 100% vs peer 300% → local fair = 25, slack 2 → shed 33
    assert.equal(
      computeWeightedShedCount({
        localCount: 60,
        localWeight: 100,
        peers: [{ count: 40, weight: 300 }],
        slack: 2,
        maxPerTick: 100,
      }),
      33,
    );
  });

  it("keeps more on a boosted local node", () => {
    // total 100, local 300% vs peer 100% → fair 75, slack 2 → no shed at 60
    assert.equal(
      computeWeightedShedCount({
        localCount: 60,
        localWeight: 300,
        peers: [{ count: 40, weight: 100 }],
        slack: 2,
        maxPerTick: 100,
      }),
      0,
    );
  });

  it("drains a 0% node all the way down, ignoring slack", () => {
    assert.equal(
      computeWeightedShedCount({
        localCount: 2,
        localWeight: 0,
        peers: [{ count: 40, weight: 100 }],
        slack: 2,
        maxPerTick: 100,
      }),
      2,
    );
  });

  it("respects maxPerTick while draining", () => {
    assert.equal(
      computeWeightedShedCount({
        localCount: 500,
        localWeight: 0,
        peers: [{ count: 40, weight: 100 }],
        slack: 2,
        maxPerTick: 50,
      }),
      50,
    );
  });

  it("does not shed when every node is drained (even split fallback)", () => {
    // All zero → fall back to even split: fair 50 + slack 2, local 50 → 0
    assert.equal(
      computeWeightedShedCount({
        localCount: 50,
        localWeight: 0,
        peers: [{ count: 50, weight: 0 }],
        slack: 2,
        maxPerTick: 100,
      }),
      0,
    );
  });

  it("never sheds as the only node", () => {
    assert.equal(
      computeWeightedShedCount({
        localCount: 100,
        localWeight: 0,
        peers: [],
        slack: 2,
      }),
      0,
    );
  });
});

describe("computeWeightedTargets", () => {
  it("splits evenly by default and loses nothing to flooring", () => {
    const t = computeWeightedTargets(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      100,
    );
    assert.equal(t.a + t.b + t.c, 100);
    assert.deepEqual([t.a, t.b, t.c].sort((x, y) => y - x), [34, 33, 33]);
  });

  it("splits by weight", () => {
    const t = computeWeightedTargets(
      [
        { id: "a", weight: 300 },
        { id: "b", weight: 100 },
      ],
      400,
    );
    assert.deepEqual(t, { a: 300, b: 100 });
  });

  it("gives a drained node nothing and its work to the rest", () => {
    const t = computeWeightedTargets(
      [
        { id: "a", weight: 0 },
        { id: "b", weight: 100 },
        { id: "c", weight: 100 },
      ],
      100,
    );
    assert.deepEqual(t, { a: 0, b: 50, c: 50 });
  });

  it("falls back to an even split when every node is drained", () => {
    const t = computeWeightedTargets(
      [
        { id: "a", weight: 0 },
        { id: "b", weight: 0 },
      ],
      40,
    );
    assert.deepEqual(t, { a: 20, b: 20 });
  });

  it("redistributes overflow from a capped node", () => {
    // a wants 80 but caps at 10 → the other 70 land on b (uncapped)
    const t = computeWeightedTargets(
      [
        { id: "a", weight: 400, maxBots: 10 },
        { id: "b", weight: 100, maxBots: 500 },
      ],
      100,
    );
    assert.deepEqual(t, { a: 10, b: 90 });
  });

  it("cascades redistribution through several capped nodes", () => {
    const t = computeWeightedTargets(
      [
        { id: "a", maxBots: 5 },
        { id: "b", maxBots: 5 },
        { id: "c", maxBots: 500 },
      ],
      90,
    );
    assert.deepEqual(t, { a: 5, b: 5, c: 80 });
  });

  it("reports what the fleet cannot hold by allocating less than total", () => {
    const t = computeWeightedTargets(
      [
        { id: "a", maxBots: 5 },
        { id: "b", maxBots: 5 },
      ],
      90,
    );
    assert.equal(t.a + t.b, 10);
  });

  it("is order-independent (all nodes agree on the same plan)", () => {
    const nodes = [
      { id: "n3", weight: 150 },
      { id: "n1", weight: 100 },
      { id: "n2", weight: 100 },
    ];
    const a = computeWeightedTargets(nodes, 77);
    const b = computeWeightedTargets([...nodes].reverse(), 77);
    assert.deepEqual(a, b);
  });

  it("is zero for every node when nothing wants polling", () => {
    assert.deepEqual(computeWeightedTargets([{ id: "a" }, { id: "b" }], 0), {
      a: 0,
      b: 0,
    });
  });
});

describe("planNodeLoad", () => {
  const fleet = [
    { id: "a", weight: 300, maxBots: 500 },
    { id: "b", weight: 100, maxBots: 500 },
  ];

  it("caps claiming at the planned target plus slack", () => {
    const a = planNodeLoad({ selfId: "a", nodes: fleet, total: 400, slack: 2 });
    assert.equal(a.target, 300);
    assert.equal(a.claimCap, 302);
    const b = planNodeLoad({ selfId: "b", nodes: fleet, total: 400, slack: 2 });
    assert.equal(b.target, 100);
    assert.equal(b.claimCap, 102);
  });

  it("never lets claim and shed disagree", () => {
    // Fractional share: the claim cap must not exceed the shed threshold, or
    // the node would grab a bot and release it every tick.
    for (let total = 0; total < 60; total++) {
      const plan = planNodeLoad({
        selfId: "b",
        nodes: [
          { id: "a", weight: 150 },
          { id: "b", weight: 100 },
          { id: "c", weight: 100 },
        ],
        total,
        slack: 2,
      });
      const shed = shedAboveTarget({
        localCount: plan.claimCap,
        target: plan.target,
        slack: plan.slack,
        maxPerTick: 50,
      });
      assert.equal(shed, 0, `total=${total} claims ${plan.claimCap} then sheds`);
    }
  });

  it("drains a 0% node with no slack", () => {
    const plan = planNodeLoad({
      selfId: "z",
      nodes: [
        { id: "z", weight: 0 },
        { id: "a", weight: 100 },
      ],
      total: 400,
      slack: 2,
    });
    assert.equal(plan.target, 0);
    assert.equal(plan.claimCap, 0);
    assert.equal(plan.slack, 0);
    assert.equal(plan.drained, true);
  });

  it("keeps slack when the whole fleet is drained (not a real drain)", () => {
    const plan = planNodeLoad({
      selfId: "z",
      nodes: [
        { id: "z", weight: 0 },
        { id: "a", weight: 0 },
      ],
      total: 40,
      slack: 2,
    });
    assert.equal(plan.drained, false);
    assert.equal(plan.target, 20);
    assert.equal(plan.claimCap, 22);
  });

  it("gives a lone node everything regardless of its weight", () => {
    const plan = planNodeLoad({
      selfId: "a",
      nodes: [{ id: "a", weight: 20 }],
      total: 90,
      slack: 0,
    });
    assert.equal(plan.target, 90);
  });

  it("reports bots no node has room for", () => {
    const plan = planNodeLoad({
      selfId: "a",
      nodes: [
        { id: "a", maxBots: 5 },
        { id: "b", maxBots: 5 },
      ],
      total: 90,
      slack: 2,
    });
    assert.equal(plan.target, 5);
    assert.equal(plan.unplaceable, 80);
  });

  it("has nothing unplaceable in a healthy fleet", () => {
    const plan = planNodeLoad({ selfId: "a", nodes: fleet, total: 400 });
    assert.equal(plan.unplaceable, 0);
  });
});

describe("shedAboveTarget", () => {
  it("sheds down to target + slack", () => {
    assert.equal(
      shedAboveTarget({ localCount: 60, target: 50, slack: 2, maxPerTick: 100 }),
      8,
    );
  });

  it("does not shed at or below the threshold", () => {
    assert.equal(shedAboveTarget({ localCount: 52, target: 50, slack: 2 }), 0);
    assert.equal(shedAboveTarget({ localCount: 10, target: 50, slack: 2 }), 0);
  });

  it("respects maxPerTick", () => {
    assert.equal(
      shedAboveTarget({ localCount: 500, target: 0, slack: 0, maxPerTick: 50 }),
      50,
    );
  });
});

describe("annotateTargetShares", () => {
  it("splits evenly by default and loses no bots to flooring", () => {
    const nodes = [node("a"), node("b"), node("c")];
    annotateTargetShares(nodes, 100);
    assert.equal(
      nodes.reduce((acc, n) => acc + (n.targetShare ?? 0), 0),
      100,
    );
    assert.deepEqual(
      nodes.map((n) => n.targetShare).sort((x, y) => (y ?? 0) - (x ?? 0)),
      [34, 33, 33],
    );
  });

  it("splits by weight", () => {
    const nodes = [
      node("a", { weight: 300, weightOverride: true }),
      node("b"),
    ];
    annotateTargetShares(nodes, 400);
    assert.equal(nodes[0]!.targetShare, 300);
    assert.equal(nodes[1]!.targetShare, 100);
  });

  it("gives a drained node nothing", () => {
    const nodes = [node("a", { weight: 0, weightOverride: true }), node("b")];
    annotateTargetShares(nodes, 50);
    assert.equal(nodes[0]!.targetShare, 0);
    assert.equal(nodes[1]!.targetShare, 50);
  });

  it("caps a share at maxBots and moves the overflow to the others", () => {
    const nodes = [
      node("a", { weight: 400, weightOverride: true, maxBots: 10 }),
      node("b", { maxBots: 500 }),
    ];
    annotateTargetShares(nodes, 100);
    assert.equal(nodes[0]!.targetShare, 10);
    assert.equal(nodes[1]!.targetShare, 90);
  });

  it("leaves bots unassigned when the whole fleet is at its cap", () => {
    const nodes = [node("a", { maxBots: 5 }), node("b", { maxBots: 5 })];
    annotateTargetShares(nodes, 90);
    assert.equal(nodes[0]!.targetShare, 5);
    assert.equal(nodes[1]!.targetShare, 5);
  });

  it("skips offline and fenced nodes", () => {
    const nodes = [
      node("a"),
      node("b", { online: false }),
      node("c", { fenced: true, online: false }),
    ];
    annotateTargetShares(nodes, 30);
    assert.equal(nodes[0]!.targetShare, 30);
    assert.equal(nodes[1]!.targetShare, null);
    assert.equal(nodes[2]!.targetShare, null);
  });

  it("defaults to the leased sum when no total is supplied", () => {
    const nodes = [
      node("a", { leasedCount: 30 }),
      node("b", { leasedCount: 10 }),
    ];
    annotateTargetShares(nodes);
    assert.equal(nodes[0]!.targetShare, 20);
    assert.equal(nodes[1]!.targetShare, 20);
  });

  it("falls back to an even split when the whole fleet is drained", () => {
    const nodes = [
      node("a", { weight: 0, weightOverride: true }),
      node("b", { weight: 0, weightOverride: true }),
    ];
    annotateTargetShares(nodes, 40);
    assert.equal(nodes[0]!.targetShare, 20);
    assert.equal(nodes[1]!.targetShare, 20);
  });
});
