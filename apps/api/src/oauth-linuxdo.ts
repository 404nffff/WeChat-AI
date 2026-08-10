import { randomBytes, createHash } from "node:crypto";

export interface LinuxDoOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

export interface LinuxDoUserInfo {
  id: string | number;
  username: string;
  name?: string;
  avatar_url?: string;
  avatar_template?: string;
  trust_level?: number;
  active?: boolean;
  silenced?: boolean;
  email?: string;
  sub?: string;
  login?: string;
}

export function loadLinuxDoConfig(
  env: NodeJS.ProcessEnv = process.env,
): LinuxDoOAuthConfig | null {
  const clientId = env.LINUXDO_CLIENT_ID ?? "";
  const clientSecret = env.LINUXDO_CLIENT_SECRET ?? "";
  const redirectUri = env.LINUXDO_REDIRECT_URI ?? "";
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl:
      env.LINUXDO_AUTHORIZE_URL ??
      "https://connect.linux.do/oauth2/authorize",
    tokenUrl:
      env.LINUXDO_TOKEN_URL ?? "https://connect.linux.do/oauth2/token",
    userInfoUrl:
      env.LINUXDO_USERINFO_URL ?? "https://connect.linux.do/api/user",
    // OIDC discovery: scopes_supported = openid, profile, email
    scope: env.LINUXDO_SCOPE ?? "openid profile",
  };
}

export function newOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export function buildAuthorizeUrl(
  cfg: LinuxDoOAuthConfig,
  state: string,
): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(
  cfg: LinuxDoOAuthConfig,
  code: string,
): Promise<{ access_token: string; token_type?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  let data: {
    access_token?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`token exchange invalid JSON: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `token exchange HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return { access_token: data.access_token, token_type: data.token_type };
}

/**
 * Resolve avatar URL from LINUX DO / Discourse / OIDC userinfo.
 * Supports avatar_url, picture, and Discourse avatar_template ("…/{size}/…").
 */
export function resolveAvatarUrl(
  raw: Record<string, unknown>,
  size = 96,
): string | undefined {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  let url =
    pick("avatar_url", "avatarUrl", "picture", "image", "avatar") ||
    undefined;

  const template = pick("avatar_template", "avatarTemplate");
  if (!url && template) {
    url = template.includes("{size}")
      ? template.replace(/\{size\}/g, String(size))
      : template;
  }

  if (!url) return undefined;

  // Protocol-relative //cdn...
  if (url.startsWith("//")) url = "https:" + url;
  // Discourse sometimes returns /user_avatar/...
  if (url.startsWith("/")) url = "https://linux.do" + url;

  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Normalize LINUX DO / OIDC userinfo into a stable shape.
 * Fields may be id|sub, username|login, name, avatar_url|picture|avatar_template, trust_level.
 */
export function normalizeUserInfo(raw: Record<string, unknown>): LinuxDoUserInfo {
  const id = raw.id ?? raw.sub ?? raw.user_id;
  const username =
    (raw.username as string) ||
    (raw.login as string) ||
    (raw.preferred_username as string) ||
    (id != null ? String(id) : "");
  if (id == null || !username) {
    throw new Error(
      `userinfo missing id/username: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return {
    id: id as string | number,
    username,
    name: (raw.name as string) || username,
    avatar_url: resolveAvatarUrl(raw),
    avatar_template:
      typeof raw.avatar_template === "string"
        ? raw.avatar_template
        : typeof raw.avatarTemplate === "string"
          ? raw.avatarTemplate
          : undefined,
    trust_level: Number(raw.trust_level ?? 0),
    active: raw.active as boolean | undefined,
    silenced: raw.silenced as boolean | undefined,
    email: raw.email as string | undefined,
    sub: raw.sub as string | undefined,
    login: raw.login as string | undefined,
  };
}

export async function fetchUserInfo(
  cfg: LinuxDoOAuthConfig,
  accessToken: string,
): Promise<LinuxDoUserInfo> {
  const res = await fetch(cfg.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`userinfo invalid JSON: HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`userinfo HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  // Some providers nest under { user: {...} }
  if (data.user && typeof data.user === "object") {
    return normalizeUserInfo(data.user as Record<string, unknown>);
  }
  return normalizeUserInfo(data);
}

export function parseAdminIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function defaultSessionSecret(): string {
  return createHash("sha256")
    .update(process.env.WECHAT_AI_TOKEN || "dev")
    .digest("hex");
}

export function isPlaceholderRedisUrl(url: string): boolean {
  return (
    !url ||
    /YOUR_ENDPOINT|YOUR_UPSTASH|password@your|localhost:6379\/0$/i.test(url) ||
    url.includes("YOUR_")
  );
}
