import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDefaultChatflowGraph } from "./default-graph.js";
import {
  evalCondition,
  renderTemplate,
  validateChatflowGraph,
} from "./validate.js";
import { ChatflowError } from "./types.js";

describe("chatflow validate", () => {
  it("accepts default graph", () => {
    const r = validateChatflowGraph(createDefaultChatflowGraph());
    assert.equal(r.ok, true);
    assert.equal(r.startId, "start");
    assert.ok(r.answerIds.includes("answer"));
  });

  it("rejects missing answer", () => {
    assert.throws(
      () =>
        validateChatflowGraph({
          version: 1,
          nodes: [{ id: "start", type: "start" }],
          edges: [],
        }),
      (e: unknown) => e instanceof ChatflowError && e.code === "invalid_graph",
    );
  });

  it("rejects duplicate start", () => {
    assert.throws(
      () =>
        validateChatflowGraph({
          version: 1,
          nodes: [
            { id: "s1", type: "start" },
            { id: "s2", type: "start" },
            { id: "a", type: "answer" },
          ],
          edges: [],
        }),
      ChatflowError,
    );
  });
});

describe("chatflow templates", () => {
  it("renders nested keys", () => {
    const out = renderTemplate("hi {{user.name}} / {{query}}", {
      query: "Q",
      user: { name: "Ada" },
    });
    assert.equal(out, "hi Ada / Q");
  });

  it("evalCondition equality and contains", () => {
    const vars = { x: "hello", n: 1 };
    assert.equal(evalCondition('x == "hello"', vars), true);
    assert.equal(evalCondition('x != "hello"', vars), false);
    assert.equal(evalCondition("x contains ell", vars), true);
    assert.equal(evalCondition("empty missing", vars), true);
    assert.equal(evalCondition("not empty x", vars), true);
  });
});
