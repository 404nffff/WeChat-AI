# 使用 Upstash Redis

本项目通过 **ioredis + Redis 协议** 连接远端 Redis，兼容 [Upstash](https://upstash.com/)。

## 1. 创建数据库

1. 登录 [Upstash Console](https://console.upstash.com/)
2. **Create Database** → 选区域（建议离你服务器近的，如 `ap-southeast-1`）
3. 打开数据库 → **Connect** / **REST API & Redis**

## 2. 复制连接串

在 Connect 面板选 **ioredis / Node.js**，复制 **Redis URL**，形如：

```text
rediss://default:AXxxxx@xxxxxx.upstash.io:6379
```

注意：

| 项 | 说明 |
|----|------|
| 协议 | 必须是 **`rediss://`**（多一个 s = TLS） |
| 用户名 | 一般为 `default` |
| 密码 | Upstash 提供的 token，当作密码 |
| 端口 | `6379` |

不要用 Upstash 的 **REST URL**（`https://xxx.upstash.io`）填到 `REDIS_URL`——那是 HTTP REST，不是本项目用的协议。

## 3. 写入 `.env`

```env
REDIS_URL=rediss://default:你的密码@你的主机.upstash.io:6379
```

可选：

```env
# 连接超时毫秒（默认 15000）
REDIS_CONNECT_TIMEOUT_MS=15000
# 若 URL 是 redis:// 但强制 TLS（一般不需要，rediss:// 已够）
REDIS_TLS=true
# 并发命令自动 pipeline（默认开；高延迟远端 Redis 强烈建议保持）
REDIS_AUTO_PIPELINE=true
# 进程内 session/user 缓存（默认开；显著降低鉴权 RTT）
REDIS_L1_CACHE=true
# TCP keep-alive 毫秒（默认 10000）
REDIS_KEEPALIVE_MS=10000
```

## 延迟优化建议

| 项 | 说明 |
|----|------|
| **区域** | Upstash 选与 API 服务器最近的 region（跨洲 RTT 常 150–300ms，串行几条命令就到秒级） |
| **避免 N+1** | 列表接口应批量 MGET/pipeline；本项目已对 me/bots、me/peers、广场列表等做批处理 |
| **L1 缓存** | 鉴权路径对 session/user 做短 TTL 进程缓存，重复请求几乎零 RTT |
| **命令数** | 免费档按命令计费；pipeline/MGET 既降延迟也降用量 |

## 4. 验证

```powershell
cd F:\Code-Other-4\WeChat-AI
pnpm diag
```

应看到类似：

```text
✓ REDIS_URL=rediss://...
✓ PONG
```

然后：

```powershell
pnpm db:seed
pnpm dev
```

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| `ECONNREFUSED` / 连不上 | 检查 URL 是否完整、是否 `rediss://`、密码有无复制错 |
| `ENOTFOUND` | 主机名错误 |
| TLS / certificate 错误 | 确认用 `rediss://`；升级 Node 20+ |
| 免费额度耗尽 | Upstash 控制台看 Command 用量；开发时减少轮询/调试 |
| 误填 REST token URL | 改用 **Redis** 协议 URL，不是 `https://...upstash.io` |

## 6. 安全建议

- 不要把 `REDIS_URL` 提交到 Git（已在 `.gitignore` 的 `.env` 中）
- 生产环境在 Upstash 开启合适的 IP 限制（若控制台提供）
- 定期轮换 token
