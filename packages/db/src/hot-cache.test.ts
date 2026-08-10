import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SnapshotCache } from "./hot-cache.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SnapshotCache", () => {
  it("serves the cached value within the TTL", async () => {
    let loads = 0;
    const c = new SnapshotCache<number>(10_000);
    const load = async () => ++loads;

    assert.equal(await c.get(load), 1);
    assert.equal(await c.get(load), 1);
    assert.equal(await c.get(load), 1);
    assert.equal(loads, 1);
  });

  it("reloads after invalidate", async () => {
    let loads = 0;
    const c = new SnapshotCache<number>(10_000);
    const load = async () => ++loads;

    await c.get(load);
    c.invalidate();
    assert.equal(await c.get(load), 2);
    assert.equal(loads, 2);
  });

  it("reloads after the TTL expires", async () => {
    let loads = 0;
    const c = new SnapshotCache<number>(1);
    const load = async () => ++loads;

    await c.get(load);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await c.get(load), 2);
  });

  it("coalesces concurrent misses into one load", async () => {
    let loads = 0;
    const c = new SnapshotCache<number>(10_000);
    const load = async () => {
      loads++;
      await tick();
      return loads;
    };

    const all = await Promise.all([c.get(load), c.get(load), c.get(load)]);
    assert.deepEqual(all, [1, 1, 1]);
    assert.equal(loads, 1);
  });

  it("does not cache a rejected load", async () => {
    const c = new SnapshotCache<number>(10_000);
    await assert.rejects(
      c.get(async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(
      await c.get(async () => 7),
      7,
    );
  });

  it("always loads when the TTL is zero", async () => {
    let loads = 0;
    const c = new SnapshotCache<number>(0);
    const load = async () => ++loads;

    await c.get(load);
    await c.get(load);
    assert.equal(loads, 2);
  });
});
