import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayKey, dayKeyOffset, DEFAULT_DAY_TZ } from "./client.js";

describe("dayKey (Asia/Shanghai)", () => {
  it("defaults timezone to Asia/Shanghai", () => {
    assert.equal(DEFAULT_DAY_TZ, "Asia/Shanghai");
  });

  it("uses China calendar date, not UTC, before 08:00 CST", () => {
    // 2026-07-20 18:03 UTC == 2026-07-21 02:03 Asia/Shanghai
    const d = new Date("2026-07-20T18:03:00.000Z");
    assert.equal(d.toISOString().slice(0, 10), "2026-07-20"); // UTC trap
    assert.equal(dayKey(d), "2026-07-21");
  });

  it("matches UTC date during China daytime after 08:00", () => {
    // 2026-07-21 10:00 CST == 2026-07-21 02:00 UTC
    const d = new Date("2026-07-21T02:00:00.000Z");
    assert.equal(dayKey(d), "2026-07-21");
  });

  it("rolls over at China midnight (16:00 UTC previous day)", () => {
    // 2026-07-20 15:59:59 UTC == 2026-07-20 23:59:59 CST
    assert.equal(dayKey(new Date("2026-07-20T15:59:59.000Z")), "2026-07-20");
    // 2026-07-20 16:00:00 UTC == 2026-07-21 00:00:00 CST
    assert.equal(dayKey(new Date("2026-07-20T16:00:00.000Z")), "2026-07-21");
  });
});

describe("dayKeyOffset", () => {
  it("returns yesterday/tomorrow relative to China calendar", () => {
    const d = new Date("2026-07-20T18:03:00.000Z"); // China 07-21 02:03
    assert.equal(dayKeyOffset(0, d), "2026-07-21");
    assert.equal(dayKeyOffset(-1, d), "2026-07-20");
    assert.equal(dayKeyOffset(1, d), "2026-07-22");
  });

  it("handles month boundaries", () => {
    // China 2026-08-01 01:00 == 2026-07-31 17:00 UTC
    const d = new Date("2026-07-31T17:00:00.000Z");
    assert.equal(dayKey(d), "2026-08-01");
    assert.equal(dayKeyOffset(-1, d), "2026-07-31");
  });
});
