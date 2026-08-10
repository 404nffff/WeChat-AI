# Cloudflare Worker 负载均衡（WeChat-AI 多节点）

把**主域名**反代到多台源站 Docker 节点，做健康检查 + 轮询分流。

源站地址只写在本 Worker 的 `ORIGINS` 里；应用内 `PUBLIC_BASE_URL` 一律填**主域名**。管理后台「节点」页显示的是 Redis 注册的进程，**不展示**源站 URL。

## 为什么 API 会慢 3～5 秒？（即使没配测活变量）

旧版 Worker **在每次用户请求里都会 `await` 健康检查**：

- 代码默认 `HEALTH_PATH=/health/ready`（会 ping Redis）
- 默认超时约 **3s**
- Cloudflare isolate **几乎不跨请求复用内存** → 探活缓存经常是冷的
- 结果：用户 API **先等探活，再访问源站** → 固定多 1～3s+

**与是否配置 `HEALTH_*` 变量无关**——变量只是覆盖默认值，默认本身就会探活。

其它次要因素：用户 → CF POP → 源站 IP 多一跳 RTT（通常几十～几百 ms，一般到不了 3～5s）。

### 已修复（请重新粘贴最新 `worker.js` 并 Deploy）

- 请求路径**不再 await 探活**；用 `waitUntil` 后台探活
- 默认探活改为轻量 **`/health`**
- 默认乐观转发（先当全健康 round-robin）
- 仅代理失败 / 502–504 时快速试下一台

部署后自检：`https://主域名/__lb/health` 应含 `"mode":"non_blocking_probe"`。  
DevTools 看 `/api/v1/...` 的 TTFB 应接近直连源站。

## 架构

```
浏览器 ──► 主域名 (CF Worker)
              ├─► http://node1:8787
              ├─► http://node2:8787
              └─► …
                     └── 共享 REDIS_URL
```

## 方式 A：Cloudflare 控制台（Hello World，推荐上手）

Dashboard **不能**直接上传整个 `src/` 文件夹；「Upload your static files」是静态站，不是 Worker 逻辑。

1. 创建 Worker → **从 Hello World! 开始**
2. 打开在线编辑器，**整份替换**为仓库里的 **`worker.js`**（单文件，已合并 LB 逻辑）
3. **Save and Deploy**
4. Worker → **Settings → Variables and Secrets** 添加：

| 名称 | 类型 | 示例 |
|------|------|------|
| `ORIGINS` | Text | `http://1.2.3.4:8787,http://5.6.7.8:8787` |
| `HEALTH_PATH` | Text（可选） | `/health`（默认；勿用 ready 除非你清楚） |
| `HEALTH_INTERVAL_MS` | Text（可选） | `15000`（后台探活间隔） |
| `HEALTH_TIMEOUT_MS` | Text（可选） | `1500` |
| `HEALTH_ON_REQUEST` | Text（可选） | 默认关；`true` 会恢复慢路径，**勿开** |
| `ORIGIN_HOST_MODE` | Text（可选） | `preserve` |
| `ORIGIN_PROXY_SECRET` | Secret（可选） | 随机长串 |
| `ADSENSE_CLIENT` | Text（可选） | 如 `ca-pub-…`；有值则注入广告脚本 |
| `ADSENSE_ENABLED` | Text（可选） | 默认 `true`；设 `false` 关闭注入 |
| `ADSENSE_SKIP_PATHS` | Text（可选） | 默认 `/admin,/api/,/__lb/,/cdn/,/health` |
| `ADSENSE_ADS_TXT` | Text（可选） | 自定义 `ads.txt` 全文；空则按 CLIENT 自动生成 |

5. **Settings → Domains & Routes / Custom Domains** 绑定主域名  
6. 自检：`https://你的主域名/__lb/health`  

若编辑器固定文件名 `worker.js`：把本仓库 `cloudflare-worker/worker.js` 内容粘进去即可。

## 方式 B：Wrangler CLI（多文件 TS）

```bash
cd cloudflare-worker
npm install
# 编辑 wrangler.toml [vars] ORIGINS，或：
npx wrangler secret put ORIGIN_PROXY_SECRET   # 可选
npx wrangler deploy
```

### 必填

| 变量 | 说明 |
|------|------|
| `ORIGINS` | 逗号分隔源站根地址，如 `http://1.2.3.4:8787,http://5.6.7.8:8787` |

### 可选

| 变量 | 默认 | 说明 |
|------|------|------|
| `HEALTH_PATH` | `/health` | 后台探活路径（轻量；不要用 ready 除非必要） |
| `HEALTH_INTERVAL_MS` | `15000` | 后台探活间隔（不阻塞用户请求） |
| `HEALTH_TIMEOUT_MS` | `1500` | 探活超时 |
| `HEALTH_ON_REQUEST` | 关 | `true` 时每次请求 await 探活（慢，仅调试） |
| `ORIGIN_HOST_MODE` | `preserve` | `preserve` 转发用户 Host；`origin` 改写为源站 Host |
| `ORIGIN_PROXY_SECRET` | — | 若设置，注入请求头 `X-WeChat-AI-Proxy-Secret` |
| `ADSENSE_CLIENT` | — | AdSense 发布商 ID（`ca-pub-…`）；设置后对公开 HTML 注入脚本 |
| `ADSENSE_ENABLED` | `true` | `false` 时关闭注入（即使配置了 CLIENT） |
| `ADSENSE_SKIP_PATHS` | 见上 | 不注入广告的路径前缀（逗号分隔） |
| `ADSENSE_ADS_TXT` | 自动 | 覆盖边缘返回的 `/ads.txt` 内容 |

## Google AdSense（边缘注入）

Worker 在**不改源站 HTML** 的前提下：

1. 对成功的 **`text/html`** 响应，用 `HTMLRewriter` 在 `<head>` 末尾注入：

   ```html
   <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-…"
        crossorigin="anonymous"></script>
   ```

2. 直接响应 **`/ads.txt`**（不必源站提供），默认内容：

   ```text
   google.com, pub-…, DIRECT, f08c47fec0942fa0
   ```

3. **默认跳过** `/admin`、`/api/*`、`/__lb/*`、`/cdn/*`、`/health`（管理后台与 API 不插广告）

4. 注入后的响应带 `X-WeChat-AI-Adsense: 1`；`GET /__lb/health` 的 JSON 含 `adsense.enabled` / `adsense.client`

控制台粘贴 `worker.js` 时，在 Variables 里加上 `ADSENSE_CLIENT`。关闭：清空 `ADSENSE_CLIENT` 或设 `ADSENSE_ENABLED=false` 后重新 Deploy。

自检：

```bash
# 应看到 adsense.enabled / client
curl -s https://你的主域名/__lb/health

# 应返回 google.com, pub-… 行
curl -s https://你的主域名/ads.txt

# 首页 HTML 的 <head> 应含 pagead2.googlesyndication.com
curl -s https://你的主域名/ | head -n 40
```

说明：这是 **Auto ads 用的全局脚本**；若要用手动广告位，仍需在页面 HTML 里放 `<ins class="adsbygoogle">`（或再扩展 Worker 注入广告位）。

### 本地调试

```bash
# 终端 1/2：两台源站（不同端口，同一 REDIS_URL）
# 终端 3：
npx wrangler dev --var ORIGINS:http://127.0.0.1:8787,http://127.0.0.1:8788
```

Worker 自检：`GET /__lb/health` → `mode: non_blocking_probe`。

## DNS

1. 主域名 **Custom Domain** 绑到本 Worker（或 CNAME 到 workers.dev 路由）。  
2. 源站 IP **不必** 橙云代理到用户；可仅允许 Cloudflare IP 访问 8787。  
3. 应用 `.env`：

```env
PUBLIC_BASE_URL=https://你的主域名
LINUXDO_REDIRECT_URI=https://你的主域名/api/v1/auth/callback
COOKIE_SECURE=true
WORKER_ID=node-01   # 每机唯一
```

## 与 Cache Rules

源站仍输出 `Cache-Control` / `Cloudflare-CDN-Cache-Control`。全站经 Worker 时，可继续用 Dashboard Cache Rules 缓存 HTML 壳与 `/cdn/s/*`（见 `docs/cloudflare.md`）。

## 算法摘要

1. 解析 `ORIGINS`  
2. 按间隔对 `HEALTH_PATH` 探活，标记 healthy  
3. 在 healthy 集合 round-robin；全挂时仍尝试一次  
4. 转发 Cookie / Method / Body；附加 `CF-Connecting-IP`、`X-Forwarded-*`  
5. 响应增加 `X-WeChat-AI-LB: 1`（标识经 LB）；不向客户端暴露源站主机名  
6. 若配置了 AdSense：公开 HTML 注入脚本；`/ads.txt` 由边缘直接返回

## 扩缩容

1. 新机器 `docker run` 同镜像，配同一 `REDIS_URL` / `PUBLIC_BASE_URL`，唯一 `WORKER_ID`  
2. 更新 Worker `ORIGINS` 并 `wrangler deploy`  
3. 管理后台 **节点** 页应出现新 `WORKER_ID` 心跳  

下线：从 `ORIGINS` 移除 → deploy；停容器后租约 TTL 过期自动转移 bot。
