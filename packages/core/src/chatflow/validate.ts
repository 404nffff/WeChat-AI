import type { ChatflowEdge, ChatflowGraph, ChatflowNodeBase } from "./types.js";
import { ChatflowError } from "./types.js";

const NODE_TYPES = new Set([
  "start",
  "llm",
  "answer",
  "if-else",
  "http",
  "memory",
  "search",
]);

export interface ValidateGraphOptions {
  maxNodes?: number;
}

export interface ValidateGraphResult {
  ok: true;
  graph: ChatflowGraph;
  startId: string;
  answerIds: string[];
}

/**
 * Structural validation for chatflow graphs.
 * Throws ChatflowError on failure.
 */
export function validateChatflowGraph(
  raw: unknown,
  opts: ValidateGraphOptions = {},
): ValidateGraphResult {
  const maxNodes = Math.max(3, Math.min(200, opts.maxNodes ?? 40));
  if (!raw || typeof raw !== "object") {
    throw new ChatflowError("invalid_graph", "graph must be an object");
  }
  const g = raw as ChatflowGraph;
  if (g.version !== 1) {
    throw new ChatflowError("invalid_graph", "graph.version must be 1");
  }
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new ChatflowError("invalid_graph", "nodes and edges required");
  }
  if (g.nodes.length > maxNodes) {
    throw new ChatflowError(
      "invalid_graph",
      `too many nodes (max ${maxNodes})`,
    );
  }
  if (!g.nodes.length) {
    throw new ChatflowError("invalid_graph", "graph has no nodes");
  }

  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n || typeof n !== "object") {
      throw new ChatflowError("invalid_graph", "invalid node");
    }
    const id = String((n as ChatflowNodeBase).id || "").trim();
    const type = (n as ChatflowNodeBase).type;
    if (!id) throw new ChatflowError("invalid_graph", "node id required");
    if (ids.has(id)) {
      throw new ChatflowError("invalid_graph", `duplicate node id: ${id}`);
    }
    if (!NODE_TYPES.has(type)) {
      throw new ChatflowError("invalid_graph", `unknown node type: ${type}`);
    }
    ids.add(id);
  }

  const starts = g.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    throw new ChatflowError("invalid_graph", "exactly one start node required");
  }
  const answers = g.nodes.filter((n) => n.type === "answer");
  if (!answers.length) {
    throw new ChatflowError("invalid_graph", "at least one answer node required");
  }

  for (const e of g.edges) {
    if (!e || typeof e !== "object") {
      throw new ChatflowError("invalid_graph", "invalid edge");
    }
    const edge = e as ChatflowEdge;
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new ChatflowError(
        "invalid_graph",
        `edge ${edge.id || "?"} references missing node`,
      );
    }
  }

  return {
    ok: true,
    graph: {
      version: 1,
      nodes: g.nodes.map((n) => ({
        id: String(n.id).trim(),
        type: n.type,
        label: n.label,
        data: n.data && typeof n.data === "object" ? n.data : {},
      })),
      edges: g.edges.map((e, i) => ({
        id: String(e.id || `e${i}`),
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
      })),
    },
    startId: starts[0]!.id,
    answerIds: answers.map((a) => a.id),
  };
}

/** Simple mustache-like {{path}} with dotted keys against a flat+nested vars bag. */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey: string) => {
    const key = String(rawKey).trim();
    if (!key) return "";
    const val = lookupVar(vars, key);
    if (val === undefined || val === null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  });
}

function lookupVar(vars: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(vars, path)) {
    return vars[path];
  }
  const parts = path.split(".");
  let cur: unknown = vars;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Evaluate a simple condition expression against vars.
 * Supports: var, var == "x", var != "x", var contains "x", empty var, not empty var
 */
export function evalCondition(
  expr: string,
  vars: Record<string, unknown>,
): boolean {
  const s = (expr || "").trim();
  if (!s) return false;
  const emptyM = /^empty\s+(.+)$/i.exec(s);
  if (emptyM) {
    const v = lookupVar(vars, emptyM[1]!.trim());
    return v === undefined || v === null || v === "";
  }
  const notEmptyM = /^(?:not\s+empty|!empty)\s+(.+)$/i.exec(s);
  if (notEmptyM) {
    const v = lookupVar(vars, notEmptyM[1]!.trim());
    return !(v === undefined || v === null || v === "");
  }
  const containsM = /^(.+?)\s+contains\s+(.+)$/i.exec(s);
  if (containsM) {
    const left = String(lookupVar(vars, containsM[1]!.trim()) ?? "");
    const right = unquote(containsM[2]!.trim(), vars);
    return left.includes(right);
  }
  const eqM = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(s);
  if (eqM) {
    const left = String(lookupVar(vars, eqM[1]!.trim()) ?? "");
    const right = unquote(eqM[3]!.trim(), vars);
    return eqM[2] === "==" ? left === right : left !== right;
  }
  // bare truthiness
  const v = lookupVar(vars, s);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return Boolean(v);
}

function unquote(token: string, vars: Record<string, unknown>): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  if (token.startsWith("{{") && token.endsWith("}}")) {
    return String(lookupVar(vars, token.slice(2, -2).trim()) ?? "");
  }
  const v = lookupVar(vars, token);
  if (v !== undefined) return String(v ?? "");
  return token;
}
