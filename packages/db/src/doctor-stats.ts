import { K } from "./keys.js";

/**
 * Pure read-planning for the admin dashboard's deep counters.
 *
 * `assignments` / `messages` / `memories` used to be hardcoded to 0 because
 * computing them naively means walking the keyspace. These helpers turn the
 * peer list the snapshot already loaded into a bounded, pipelineable set of
 * keys — no Redis access, so the sizing rules are unit-testable.
 */

export interface PeerPair {
  botId: string;
  peerId: string;
}

/** `wa:peers:all` members are `botId|peerId`. Malformed entries are dropped. */
export function parsePeerPairs(members: readonly string[]): PeerPair[] {
  const out: PeerPair[] = [];
  for (const member of members) {
    const raw = String(member);
    // peerId is opaque and could itself contain "|", so split on the first only
    const sep = raw.indexOf("|");
    if (sep <= 0) continue;
    const botId = raw.slice(0, sep);
    const peerId = raw.slice(sep + 1);
    if (botId && peerId) out.push({ botId, peerId });
  }
  return out;
}

export function pairKey(pair: PeerPair): string {
  return `${pair.botId}|${pair.peerId}`;
}

export function assignmentKeys(pairs: readonly PeerPair[]): string[] {
  return pairs.map((p) => K.assignment(p.botId, p.peerId));
}

export function messageKeys(pairs: readonly PeerPair[]): string[] {
  return pairs.map((p) => K.messages(p.botId, p.peerId));
}

/**
 * Memory lists worth counting, at most two per peer.
 *
 * Memories are keyed by (bot, peer, persona), and a peer can have leftover
 * lists from personas it is no longer assigned to. Enumerating peers × all
 * personas would explode, so this counts the persona actually in effect — the
 * assignment, else the platform default. Memories orphaned by a *past*
 * assignment are therefore not counted; that is the documented trade for
 * keeping this O(peers) instead of O(peers × personas).
 */
export function memoryKeys(
  pairs: readonly PeerPair[],
  assignedPersonaByPair: ReadonlyMap<string, string>,
  defaultPersonaId: string | null,
): string[] {
  const keys: string[] = [];
  for (const pair of pairs) {
    const assigned = assignedPersonaByPair.get(pairKey(pair)) ?? null;
    const personaIds = new Set<string>();
    if (assigned) personaIds.add(assigned);
    if (defaultPersonaId) personaIds.add(defaultPersonaId);
    for (const personaId of personaIds) {
      keys.push(K.memories(pair.botId, pair.peerId, personaId));
    }
  }
  return keys;
}

/**
 * Whether the deep counters are affordable for this dataset.
 *
 * Each peer costs ~4 extra key reads (assignment + messages + up to 2 memory
 * lists). Past the cap the snapshot reports `deepStats: false` so the UI can say
 * "not measured" instead of showing a zero that reads like "none".
 */
export const DEFAULT_DEEP_STATS_MAX_PEERS = 5000;

export function deepStatsMaxPeers(
  env: NodeJS.ProcessEnv = process.env,
): number {
  // Unset must not fall through to Number("") === 0, which would silently
  // disable the counters in every default deployment.
  const raw = (env.DOCTOR_DEEP_STATS_MAX_PEERS ?? "").trim();
  if (!raw) return DEFAULT_DEEP_STATS_MAX_PEERS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DEEP_STATS_MAX_PEERS;
  // An explicit 0 / negative disables the deep counters entirely.
  return Math.max(0, Math.floor(n));
}

export function shouldComputeDeepStats(
  peerCount: number,
  maxPeers: number,
): boolean {
  if (maxPeers <= 0) return false;
  return peerCount <= maxPeers;
}
