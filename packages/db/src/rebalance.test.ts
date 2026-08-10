import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRebalanceShedCount } from "./worker-fleet.js";

describe("computeRebalanceShedCount", () => {
  it("does not shed with a single worker", () => {
    assert.equal(
      computeRebalanceShedCount({ localCount: 100, peerCounts: [] }),
      0,
    );
  });

  it("does not shed when already balanced", () => {
    assert.equal(
      computeRebalanceShedCount({
        localCount: 50,
        peerCounts: [50],
        slack: 2,
      }),
      0,
    );
  });

  it("sheds excess above fair share + slack", () => {
    // total 1122, 2 workers → fair 561; local 1122 → shed to 561+2
    const shed = computeRebalanceShedCount({
      localCount: 1122,
      peerCounts: [0],
      slack: 2,
      maxPerTick: 50,
    });
    assert.equal(shed, 50); // capped by maxPerTick
  });

  it("respects maxPerTick and slack", () => {
    // total 100, 2 workers fair=50; local 60 slack 2 → targetMax 52 → shed 8
    assert.equal(
      computeRebalanceShedCount({
        localCount: 60,
        peerCounts: [40],
        slack: 2,
        maxPerTick: 100,
      }),
      8,
    );
  });

  it("three-way fair share", () => {
    // total 300, 3 workers fair=100; local 200 peers 50,50 → targetMax 102 → shed 98
    assert.equal(
      computeRebalanceShedCount({
        localCount: 200,
        peerCounts: [50, 50],
        slack: 2,
        maxPerTick: 1000,
      }),
      98,
    );
  });
});
