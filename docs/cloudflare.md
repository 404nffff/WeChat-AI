# Cloudflare Business 缓存适配

本项目源站（Fastify Docker）已输出 **Cloudflare 友好** 的缓存头。你只需在 Cloudflare Dashboard 配好 **Cache Rules** 与区域级开关，即可最大化边缘命中。

相关代码：

| 能力 | 位置 |
|------|------|
| HTML / OG 内存缓冲 + ETag | `apps/api/src/static-pages.ts`, `index.ts` |
| 统一 Cache-Control | `apps/api/src/cache-headers.ts` |
| 公开表情 CDN | `GET /cdn/s/:id?v={content_hash}` |
| 默认 API `private, no-store` | `apps/api/src/routes.ts` `onSend` |
| CORS 白名单 | `CORS_ORIGINS` + `PUBLIC_BASE_URL` |

**本阶段不上 R2**；公开表情仍由源站 Redis blob 提供，靠边缘长缓存降压。

---

## 1. 源站响应策略（已实现）

| 路径 | Cache-Control | Cloudflare-CDN-Cache-Control | 鉴权 |
|------|---------------|------------------------------|------|
| `/` `/docs` | `public, max-age=300` | `max-age=3600, swr=86400` | 无 |
| `/app` `/admin` | `public, max-age=60` | `max-age=3600, swr=86400` | 无（壳静态；数据走 API） |
| `/og.jpg` | `public, max-age=86400, immutable` | `max-age=604800` | 无 |
| `/cdn/s/:id?v=` | `public, max-age=31536000, immutable` | 同左 | **无**；仅 public+approved+enabled |
| `/api/v1/auth/config` | `private, no-store` | — | 无（登录方式开关需实时） |
| `/health` | `no-store` | — | 无 |
| 其余 `/api/v1/**` | `private, no-store` | — | Cookie 会话 |
| 鉴权表情图 | `private, no-store` | — | 登录 / admin |

HTML 带 `ETag` + `Cache-Tag: html-shell`；公开表情带 `Cache-Tag: sticker-{id}`（便于定向 Purge）。

---

## 2. DNS / SSL

1. 域名 A/AAAA/CNAME 橙云代理到源站  
2. SSL/TLS → **Full (strict)**  
   - 源站用有效证书，或 [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)  
3. Always Use HTTPS = On  
4. 源站 `.env`：  
   - `PUBLIC_BASE_URL=https://你的域名`  
   - `COOKIE_SECURE=true`  
   - `LINUXDO_REDIRECT_URI=https://你的域名/api/v1/auth/callback`  
   - 可选 `CORS_ORIGINS=https://你的域名`（默认已含 PUBLIC_BASE_URL origin）

---

## 3. Cache Rules（按顺序创建，先匹配先生效）

路径：**Caching → Cache Rules**（Business 推荐用 Cache Rules，而不是旧 Page Rules）。

### Rule 1 — Bypass 动态 API

- **Name:** `bypass-api-private`  
- **When:**  
  `starts_with(http.request.uri.path, "/api/v1/")`  
  或方法为 `POST` / `PUT` / `PATCH` / `DELETE`  
- **Then:** Cache eligibility = **Bypass cache**

### Rule 2 — HTML 壳 Cache Everything + 忽略 Cookie

- **Name:** `cache-html-shells`  
- **When:**  
  `http.request.uri.path in {"/" "/app" "/docs" "/admin"}`  
- **Then:**  
  - Eligible for cache  
  - Edge TTL: **Respect origin**（或 Override 1 hour）  
  - Browser TTL: Respect origin  
  - **Cache key → Ignore query string**（可选）  
  - **Cookie handling → Ignore presence of cookies**（**关键**：否则带 `wa_session` 永远 MISS）

### Rule 3 — OG 图

- **Name:** `cache-og`  
- **When:** `http.request.uri.path eq "/og.jpg"`  
- **Then:** Eligible for cache；Edge TTL Respect origin 或 7d；**Ignore cookies**

### Rule 4 — 公开表情 CDN

- **Name:** `cache-cdn-stickers`  
- **When:** `starts_with(http.request.uri.path, "/cdn/s/")`  
- **Then:** Eligible for cache；Edge TTL Respect origin；**Ignore cookies**  
- Cache key **保留 query string**（`v=` 内容哈希）

### Rule 5 — ~~auth/config 短缓存~~（已移除）

> `/api/v1/auth/config` 现返回 `no-store`（登录方式开关需实时生效，不应缓存）。Cloudflare 默认尊重源站 `Cache-Control`，无 `public` 的响应不进共享缓存，故该路径**无需**任何缓存规则。

### 默认

未匹配规则时：尊重源站 `Cache-Control`；无 `public` 的不进共享缓存。

---

## 4. 区域级推荐（Business）

| 设置 | 建议 |
|------|------|
| HTTP/3 (QUIC) | On |
| Brotli | On |
| Tiered Cache | On |
| Early Hints | 可选（当前 HTML 内联，收益有限） |
| Auto Minify | **Off**（避免改 HTML 导致 ETag 与部署不一致） |
| Rocket Loader | **Off** |
| Polish | 可选；若开 WebP，注意 `Accept` 变体，或只对 `/cdn/s/*` 试 |
| Mirage | 可选（移动列表） |
| Cache Reserve | 可选（长尾表情） |
| Argo Smart Routing | 源站距用户远时可选 |
| WAF Managed Rules | On |
| Rate limiting | 建议：`/api/v1/auth/*`、try-chat、上传 POST |
| Bot Fight | 按需；勿误伤 OAuth 回调 |

---

## 5. 部署后刷新缓存

| 变更 | 做法 |
|------|------|
| 新版本 HTML（app/admin/docs/landing） | Purge by URL：`/` `/app` `/docs` `/admin`，或 Purge by Tag：`html-shell` |
| 换图表情 | **无需 purge**：`?v={content_hash}` 自动新键 |
| 下架 / 拒绝公开表情 | 源站 404；边缘可能仍 HIT 至 TTL → Purge URL 或 Tag `sticker-{id}` |
| 紧急全站 | Purge Everything（会短暂升高源站压力） |

API Purge 示例（可选）：

```bash
# 需要 Zone ID + API Token (Cache Purge 权限)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://你的域名/","https://你的域名/app","https://你的域名/docs","https://你的域名/admin"]}'
```

---

## 6. 验收 curl

```bash
HOST=https://你的域名

# HTML：第二次应 CF-Cache-Status: HIT（即使带假 cookie）
curl -sI "$HOST/" | grep -iE 'cf-cache-status|cache-control|etag|content-encoding'
curl -sI "$HOST/app" -H "Cookie: wa_session=fake" | grep -i cf-cache-status

# 公开表情
curl -sI "$HOST/cdn/s/$STICKER_ID?v=$HASH" | grep -iE 'cf-cache-status|cache-control'
curl -sI "$HOST/cdn/s/$STICKER_ID?v=$HASH" | grep -i cf-cache-status   # HIT

# 私有 API
curl -sI "$HOST/api/v1/auth/me" -H "Cookie: wa_session=..." | grep -iE 'cache-control|cf-cache-status'
# 期望: private, no-store；DYNAMIC 或 BYPASS

# 压缩
curl -sI -H 'Accept-Encoding: br' "$HOST/app" | grep -i content-encoding

# 私有 / 未审表情不得公开
curl -sI "$HOST/cdn/s/$PRIVATE_ID"   # 404
```

Dashboard → Caching → Cache Analytics 可看 HIT 率。

---

## 7. 反代注意

- 优先 **CF 橙云 → 源站 443/8787**，中间少一层  
- **多节点负载均衡**：使用仓库内 **`cloudflare-worker/`**（静态 `ORIGINS` + 健康检查 + 轮询），主域名绑 Worker；详见 `cloudflare-worker/README.md`  
- 若 Nginx 仅 TLS 终结再反代 Node：  
  - 转发 `Host`、`X-Forwarded-Proto`、`CF-Connecting-IP`  
  - **不要**强行剥掉 `Accept-Encoding` 导致双重压缩混乱  
- 源站健康检查：`GET /health`（进程）或 `GET /health/ready`（含 Redis，推荐给 LB）  
- 应用侧 `PUBLIC_BASE_URL` 始终为主域名；源站 IP 不必暴露在后台 UI
---

## 8. 安全边界

- `/cdn/s/*` **仅** `visibility=public` 且 `review_status=approved` 且 `enabled`  
- 私有 / pending / rejected → 统一 404  
- 用户 JSON、admin、try-chat、OAuth callback **永不**边缘共享缓存  
- 广场列表含 `inLibrary` 个性化，**不**做公共 CDN 缓存（升级路径：拆无个性化的 public catalog API）

---

## 9. 可选升级路径（未实现）

1. 公开表情同步 **R2** + 自定义域，源站只写 meta  
2. 拆 `GET /api/v1/public/square/*` 无 `inLibrary` 的目录接口短缓存  
3. 内联 CSS/JS 拆出带 content-hash 的静态文件  
4. Cache Reserve + Image Resizing  

详见主 README / 本文件与 `docs/docker.md` 交叉引用。
