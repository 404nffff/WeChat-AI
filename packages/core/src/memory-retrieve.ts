import type { MemoryRow } from "@wechat-ai/db";

export interface MemoryRetrieveOptions {
  /** Inject at most this many memories when count exceeds fullInjectMax (default 12) */
  topK?: number;
  /** If total memories ≤ this, inject all without scoring (default 20) */
  fullInjectMax?: number;
}

/**
 * Normalize Chinese/English text for crude token overlap scoring.
 * No external tokenizer / embedding API.
 */
export function normalizeForScore(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract overlapping terms: CJK bigrams + latin words (≥2 chars). */
export function extractTerms(text: string): string[] {
  const n = normalizeForScore(text);
  if (!n) return [];
  const terms = new Set<string>();
  // latin / digit words
  for (const m of n.match(/[a-z0-9]{2,}/g) ?? []) {
    terms.add(m);
  }
  // CJK runs → bigrams + unigrams for short runs
  const cjkRuns = n.match(/[㐀-鿿豈-﫿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      terms.add(run.slice(i, i + 2));
    }
    // also keep full short phrases (≤6) for exact-ish match boost
    if (run.length <= 6) terms.add(run);
  }
  return [...terms];
}

export function scoreMemoryAgainstQuery(
  memoryContent: string,
  queryTerms: Set<string>,
  queryNorm: string,
): number {
  const content = memoryContent ?? "";
  if (!content.trim() || !queryTerms.size) return 0;
  const memNorm = normalizeForScore(content);
  if (!memNorm) return 0;

  let score = 0;
  // substring boost when query chunk appears in memory or vice versa
  if (queryNorm.length >= 2 && memNorm.includes(queryNorm)) {
    score += 8;
  } else if (memNorm.length >= 2 && queryNorm.includes(memNorm)) {
    score += 5;
  }

  const memTerms = extractTerms(content);
  for (const t of memTerms) {
    if (queryTerms.has(t)) {
      // longer terms (bigrams / words) weigh more
      score += t.length >= 2 ? 2 : 1;
    }
  }
  return score;
}

/**
 * Select memories for prompt injection.
 * - ≤ fullInjectMax → all (stable order)
 * - else → top-K by text overlap with query; ties keep original order (newer-ish list order)
 */
export function selectMemoriesForPrompt(
  memories: MemoryRow[],
  queryText: string,
  opts: MemoryRetrieveOptions = {},
): MemoryRow[] {
  const topK = Math.max(1, opts.topK ?? 12);
  const fullInjectMax = Math.max(0, opts.fullInjectMax ?? 20);
  if (!memories.length) return [];
  if (memories.length <= fullInjectMax) return memories;

  const queryNorm = normalizeForScore(queryText);
  const queryTerms = new Set(extractTerms(queryText));

  // If query empty, keep most recent-looking tail (list is typically chronological push)
  if (!queryTerms.size) {
    return memories.slice(-topK);
  }

  const ranked = memories
    .map((m, index) => ({
      m,
      index,
      score: scoreMemoryAgainstQuery(m.content, queryTerms, queryNorm),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // prefer later entries on tie (often newer)
      return b.index - a.index;
    });

  // Always include at least some high-score ones; if all zero, take tail
  const best = ranked[0]?.score ?? 0;
  if (best <= 0) {
    return memories.slice(-topK);
  }
  return ranked.slice(0, topK).map((r) => r.m);
}

/**
 * Merge / dedupe fact strings for storage.
 * - trim, drop empty
 * - drop exact duplicates (case-insensitive)
 * - drop facts that are strict substrings of a longer fact
 * - cap at maxItems (keep last / longer preferred order of input)
 */
export function normalizeFactList(
  facts: string[],
  maxItems = 100,
): string[] {
  const cleaned = facts
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter(Boolean);

  // Prefer longer facts first when checking containment
  const byLen = [...cleaned].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  const lowerKept: string[] = [];

  for (const f of byLen) {
    const low = f.toLowerCase();
    if (lowerKept.some((k) => k === low)) continue;
    // drop if this is substring of an already kept longer fact
    if (lowerKept.some((k) => k.includes(low) && k !== low)) continue;
    // if a shorter kept fact is substring of this, remove the shorter one
    for (let i = kept.length - 1; i >= 0; i--) {
      if (low.includes(lowerKept[i]) && low !== lowerKept[i]) {
        kept.splice(i, 1);
        lowerKept.splice(i, 1);
      }
    }
    kept.push(f);
    lowerKept.push(low);
  }

  // Restore roughly input order among survivors
  const order = new Map(cleaned.map((f, i) => [f.toLowerCase(), i]));
  kept.sort(
    (a, b) =>
      (order.get(a.toLowerCase()) ?? 0) - (order.get(b.toLowerCase()) ?? 0),
  );

  const max = Math.max(1, maxItems);
  if (kept.length <= max) return kept;
  // keep the most recent-ish (end of list) when over cap
  return kept.slice(-max);
}
