import type { RedisStore } from "./client.js";
import { newId, nowIso } from "./client.js";
import { K } from "./keys.js";
import {
  decryptSecret,
  encryptSecret,
  maskApiKey,
} from "./secret-crypto.js";

export interface UserLlmProvider {
  id: string;
  owner_user_id: string;
  name: string;
  base_url: string;
  /** AES-GCM ciphertext; never expose via public API */
  api_key_enc: string;
  default_model: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface UserLlmProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function assertSafeBaseUrl(url: string): string {
  const u = normalizeBaseUrl(url);
  if (!u) throw new Error("base_url required");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("base_url invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base_url must be http(s)");
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host === "metadata" ||
    host === "metadata.google.internal"
  ) {
    throw new Error("base_url host not allowed");
  }
  // Main site still must not dial user URL; HF tools re-checks private IPs.
  return u;
}

export function toPublicProvider(
  p: UserLlmProvider,
  secret: string,
): UserLlmProviderPublic {
  let masked = "****";
  try {
    masked = maskApiKey(decryptSecret(p.api_key_enc, secret));
  } catch {
    masked = "****";
  }
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    defaultModel: p.default_model,
    enabled: Boolean(p.enabled),
    apiKeyMasked: masked,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function getLlmProvider(
  db: RedisStore,
  id: string,
): Promise<UserLlmProvider | null> {
  return db.getJson<UserLlmProvider>(K.llmProvider(id));
}

export async function listLlmProvidersByOwner(
  db: RedisStore,
  ownerUserId: string,
): Promise<UserLlmProvider[]> {
  const ids = await db.redis.smembers(K.llmProvidersByOwner(ownerUserId));
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => getLlmProvider(db, id)));
  return rows
    .filter((r): r is UserLlmProvider => Boolean(r))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function createLlmProvider(
  db: RedisStore,
  input: {
    ownerUserId: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    secret: string;
  },
): Promise<UserLlmProvider> {
  const name = input.name.trim().slice(0, 64);
  if (!name) throw new Error("name required");
  const baseUrl = assertSafeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("api_key required");
  const model = input.defaultModel.trim().slice(0, 128);
  if (!model) throw new Error("default_model required");

  const id = newId("llmp");
  const now = nowIso();
  const row: UserLlmProvider = {
    id,
    owner_user_id: input.ownerUserId,
    name,
    base_url: baseUrl,
    api_key_enc: encryptSecret(apiKey, input.secret),
    default_model: model,
    enabled: 1,
    created_at: now,
    updated_at: now,
  };
  await db.setJson(K.llmProvider(id), row);
  await db.redis.sadd(K.llmProvidersByOwner(input.ownerUserId), id);
  return row;
}

export async function updateLlmProvider(
  db: RedisStore,
  id: string,
  ownerUserId: string,
  patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    enabled?: boolean;
    secret: string;
  },
): Promise<UserLlmProvider> {
  const row = await getLlmProvider(db, id);
  if (!row || row.owner_user_id !== ownerUserId) {
    throw new Error("not_found");
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 64);
    if (!name) throw new Error("name required");
    row.name = name;
  }
  if (patch.baseUrl !== undefined) {
    row.base_url = assertSafeBaseUrl(patch.baseUrl);
  }
  if (patch.apiKey !== undefined && patch.apiKey.trim()) {
    row.api_key_enc = encryptSecret(patch.apiKey.trim(), patch.secret);
  }
  if (patch.defaultModel !== undefined) {
    const model = patch.defaultModel.trim().slice(0, 128);
    if (!model) throw new Error("default_model required");
    row.default_model = model;
  }
  if (patch.enabled !== undefined) {
    row.enabled = patch.enabled ? 1 : 0;
  }
  row.updated_at = nowIso();
  await db.setJson(K.llmProvider(id), row);
  return row;
}

export async function deleteLlmProvider(
  db: RedisStore,
  id: string,
  ownerUserId: string,
): Promise<boolean> {
  const row = await getLlmProvider(db, id);
  if (!row || row.owner_user_id !== ownerUserId) return false;
  await db.redis.del(K.llmProvider(id));
  await db.redis.srem(K.llmProvidersByOwner(ownerUserId), id);
  return true;
}

export interface ResolvedUpstream {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
}

/**
 * Resolve user custom upstream for a persona. Returns null → use platform LLM.
 * Caller must only use this with tools gateway (never dial baseUrl from main).
 */
export async function resolvePersonaUpstream(
  db: RedisStore,
  opts: {
    llmProviderId: string | null | undefined;
    /** Bot owner must own the provider */
    ownerUserId: string | null | undefined;
    secret: string;
  },
): Promise<ResolvedUpstream | null> {
  const pid = (opts.llmProviderId || "").trim();
  if (!pid || !opts.ownerUserId) return null;
  const row = await getLlmProvider(db, pid);
  if (!row || !row.enabled) return null;
  if (row.owner_user_id !== opts.ownerUserId) return null;
  let apiKey: string;
  try {
    apiKey = decryptSecret(row.api_key_enc, opts.secret);
  } catch {
    return null;
  }
  return {
    baseUrl: row.base_url,
    apiKey,
    model: row.default_model,
    providerId: row.id,
  };
}
