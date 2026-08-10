# Docker ?¨ç½²

## ?ç½®?¡ä»¶

| ä¾è? | è¯´æ? |
|------|------|
| Docker + Compose | ?¬æœº?–æ??¡å™¨å·²å?è£?|
| Upstash Redis | `.env` ä¸?`REDIS_URL=rediss://...` |
| LINUX DO OAuth | Client ID/Secret + **?¬ç??è??°å?** |
| å¹³å° LLMï¼ˆä¸»ç«™ç›´è¿ï? | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` |
| å·¥å…·ç½‘å…³ï¼ˆç”¨?·è‡ªå®šä? API + ?œç´¢ï¼?| `TOOLS_BASE_URL` / `TOOLS_API_KEY`ï¼›é??è? `huggingface/wechat-ai-tools` |


## å¿«é€Ÿå¯??
```bash
cd /path/to/WeChat-AI

# ?ç½®?¯å??˜é?ï¼ˆå‹¿?äº¤ .envï¼?# ?Ÿäº§?¡å?ä¿®æ”¹ï¼?#   PUBLIC_BASE_URL=https://ä½ ç??Ÿå?
#   LINUXDO_REDIRECT_URI=https://ä½ ç??Ÿå?/api/v1/auth/callback
#   REDIS_URL / LLM_* / LINUXDO_CLIENT_*
# ?¨æˆ·?ªå?ä¹?API + ?œç´¢ï¼šTOOLS_BASE_URL / TOOLS_API_KEY
#   docker compose --profile tools up -d --build
#   TOOLS_BASE_URL=http://wechat-ai-tools:7860

# ?¨è?ï¼šå???+ ??OTA ??+ ?„å»ºï¼ˆæ??€ Cookieï¼?pnpm docker:up
# ?ªå?ä¹‰é??å?ï¼?pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .

# ?…åœ¨ dist/release/<?ˆæœ¬>/files.json
# æµè??¨ç™»å½?/admin ???¨ç½²?‚ç‚¹ ?’ã€Œä?ä¼ é€šé??…ã€â? ?ç‚¹?‚ç‚¹?Œæ›´?°ã€?
docker compose logs -f wechat-ai
```

### ?•ç‹¬?„å»º tools ?œå?

```bash
docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools
docker run --rm -p 7860:7860 -e TOOLS_API_KEY=secret -e ALLOW_REQUEST_UPSTREAM=true wechat-ai-tools:latest
```

è¯¦è? `docs/ai-gateway.md`?`huggingface/wechat-ai-tools/README.md`??

> **?ˆæœ¬ä¸é€šé?ï¼?* `pnpm docker:build` é»˜è®¤ï¼šå?????**?¬åœ° pack** ??Docker?? 
> ?šé??‘å??ªèµ°ç½‘é¡µï¼š`/admin` ??ä¸Šä? `files.json`ï¼ˆæ? CLI Cookieï¼‰ã€? 
> ?´æ¥è·?`docker build` **ä¸ä?**?‡ç??ä?**ä¸ä?**?“é€šé??…ã€?
| ?°å? | è¯´æ? |
|------|------|
| `/` | ?Ÿèƒ½ä»‹ç??½åœ°é¡µï?OG ?†äº«??`/og.jpg`ï¼?|
| `/app` | ?¨æˆ·ä¸­å?ï¼ˆLINUX DO ?»å??å??ºå™¨äººï? |
| `/admin` | ç®¡ç??å°ï¼ˆä»ªè¡¨ç? / Tokenï¼?|
| `/health` | ?¥åº·æ£€??|

## ä»…ç”¨ Dockerfile

```bash
# ?‡ç? + docker build -t wechat-ai .
pnpm docker:build -- --raw
# ?–è‡ªå®šä?ï¼šnode scripts/docker-build.mjs -- docker build -t wechat-ai:0.2.1 .

docker run -d --name wechat-ai --restart unless-stopped \
  --env-file .env \
  -e WECHAT_AI_HOST=0.0.0.0 \
  -e WECHAT_AI_PORT=8787 \
  -p 8787:8787 \
  wechat-ai
```

Bot token ä¸è¡¨?…å??‡å? **Redis**ï¼ˆä? `REDIS_URL` ?Œå?ï¼‰ï?å®¹å™¨?å»ºä¸ä¸¢ï¼›æ??€?¬åœ°?°æ®?·ã€?
## ?Ÿäº§?¯å?æ£€?¥æ???
1. **LINUX DO** åº”ç”¨?è?ä¸?`.env` å®Œå…¨ä¸€?´ï?  
   `https://ä½ ç??Ÿå?/api/v1/auth/callback`
2. **`PUBLIC_BASE_URL`** = `https://ä½ ç??Ÿå?`ï¼ˆæ?å°¾æ?? ï?
3. **HTTPS** ?¶è®¾ç½?`COOKIE_SECURE=true`
4. **Redis** ä½¿ç”¨ Upstash `rediss://`ï¼Œæ??¡å™¨?½è®¿?®å?ç½?5. Bot **token å·²å???Redis**ï¼ˆä? `REDIS_URL` ?Œå?ï¼‰ï??å»ºå®¹å™¨ä¸ä?ä¸¢ç™»å½?
## å¸¸ç”¨?½ä»¤

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down          # ?œæ??¡ï?Bot token ??Redisï¼Œä??—å½±?ï?
docker compose down -v       # ??downï¼ˆæœ¬?åŠ¡? æ?ä¹…å? volumeï¼?pnpm docker:up                                # ?‡ç?+?¬åœ° pack+compose up --build
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# ?¶å? /admin ??ä¸Šä??šé???(files.json) ???´æ–°?‚ç‚¹
pnpm docker:build -- --no-channel             # ?ªå??ˆæ?å»ºï?ä¸?pack
```

## OTA å¢é??´æ–°ï¼ˆå??‚ç‚¹?¥å¸¸?­ä¿®ï¼?
ä¸šåŠ¡æºç?å°æ”¹?¯ä?å¿…æ???`docker build`ï¼šæœ¬??pack ??ç®¡ç??å°ä¸Šä??šé?????å¯¹è½?è??¹ç‚¹?Œæ›´?°ã€ã€?
```bash
# ?„å»ºé¡ºå¸¦?“é€šé???pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# ?–ä? packï¼?pnpm release:pack

# æµè???/admin ???¨ç½²?‚ç‚¹ ?’ã€Œä?ä¼ é€šé??…ã€é€?dist/release/<ver>/files.json
# ?’ã€Œæ›´?°å…¨?¨è½?ã€?```

| é¡?| è¯´æ? |
|----|------|
| å·®é? | ?‰æ?ä»?sha256 æ¯”å¯¹ï¼Œåªä¸‹å??˜æ›´?‡ä»¶ |
| ?å¯ | ?‚ç‚¹ `process.exit(0)`ï¼Œä?èµ?`restart: unless-stopped` ?‰èµ·**?Œä?å®¹å™¨**ï¼ˆå¯?™å?ä¿ç?è¡¥ä?ï¼?|
| ?ˆæœ¬ | å¿ƒè·³ `version`ï¼š`.wa-version`ï¼ˆOTA ?™å…¥ï¼‰â? `APP_VERSION` ????`package.json` |
| ä»é??œå? | Node ?ºç??œå??ç³»ç»Ÿå??Dockerfile?`OTA_ALLOW_INSTALL=false` ?¶ç?ä¾è?å¤§å? |

?¯å??˜é?ï¼š`OTA_ENABLED`ï¼ˆé?è®?trueï¼‰ã€`OTA_ALLOW_INSTALL`?`APP_VERSION`ï¼ˆæ? OTA ?³æ—¶?¯é€‰ï??`OTA_STAGING_DIR`?? 
**æ³¨æ?ï¼?* OTA ?ªæ”¹?‡ä»¶?ä??¹ç¯å¢ƒå??ï??ˆæœ¬??`/app/.wa-version` ä¸ŠæŠ¥ï¼Œæ??€?ä?ä¸å???`APP_VERSION` è·Ÿç??? 
`docker compose up --build` / ?å»ºå®¹å™¨ä¼šä¸¢?‰ä???OTA ?™å…¥?„è¡¥ä¸ï??¿æ?ä»ä»¥?œå?ä¸?source of truth??
## ?ä»£ç¤ºä?

?Ÿäº§?¨è??Šå??æ???**Cloudflare**ï¼ˆæ?äº‘ä»£??+ Cache Rulesï¼‰ï?è§?**`docs/cloudflare.md`**ï¼ˆBusiness ç¼“å?è§„å??å¿½??Cookie?Purge æ¸…å?ï¼‰ã€?
### Caddyï¼ˆæ? CF ?¶ï?

```caddy
your.domain.com {
  reverse_proxy 127.0.0.1:8787
}
```

### Nginxï¼ˆæ? CF ?¶ï???CF ??Nginx ??Nodeï¼?
```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Cloudflare è¿˜å??Ÿå? IP ?¶å¯?¨ï?
    # proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
  }
}
```

æºç?å·²è???`Cache-Control` / `Cloudflare-CDN-Cache-Control`?HTML ETag?å…¬å¼€è¡¨æ? `/cdn/s/:id?v=`?‚å?ä»??**ä¸å?**?å? `proxy_cache`ï¼Œé™¤?ä?ä¸ç”¨ Cloudflare??## ?œå?è¯´æ?

- ?ºç??œå?ï¼š`node:22-bookworm-slim`
- ?…ç®¡?†ï?pnpm monorepo
- ?¯åŠ¨ï¼š`pnpm db:seed`ï¼ˆå?ç­‰ï???`pnpm --filter @wechat-ai/api start`ï¼?*API + Worker ?Œè?ç¨?*ï¼?- ??root ?¨æˆ· `appuser` è¿è?
- ?¥åº·æ£€?¥ï?`GET /health`

## Worker è§„æ¨¡ï¼ˆå??œå?ï¼?
é»˜è®¤ä»æ˜¯ **ä¸€ä¸ªå®¹?¨è??¨éƒ¨**ï¼šHTTP + iLink ?¿è½®è¯?+ AI ?å???
| ?¯å??˜é? | é»˜è®¤ | è¯´æ? |
|----------|------|------|
| `MAX_BOTS_PER_WORKER` | `500` | ?¬è?ç¨‹æ?å¤šå???long-poll ??bot ??|
| `REPLY_CONCURRENCY` | `16` | ?Œæ—¶è¿›è???LLM/?‘é€ä»»?¡æ•° |
| `LEASE_TTL_SEC` | `45` | ç§Ÿçº¦ TTLï¼ˆå??œå?å¤šå‰¯?¬æ—¶?²é?å¤?pollï¼?|

?ºå™¨äººå?å¤šæ—¶ä¼˜å?è°ƒé? `MAX_BOTS_PER_WORKER` ä¸ç³»ç»?`ulimit -n`ï¼ˆæ³¨?å?å­˜ä??ºç?è¿æ¥?°ï??? 
é»˜è®¤ **?•å‰¯?¬ä?ä½“éƒ¨ç½?* ?³å¯ï¼›å??œå?å¤šå‰¯?¬å·²?¯æ?ï¼ˆRedis ç§Ÿçº¦?†ç? pollï¼‰ã€?
## å¤šè??¹å??„éƒ¨ç½²ï?10+ ?°ï?

æ¯å°?åŠ¡?¨è?**?Œä??œå?**ï¼ˆAPI + Workerï¼‰ï??±ç”¨ä¸€ä¸?Upstash Redisï¼›ç”¨?·åªè®¿é—®**ä¸»å???*??
### åº”ç”¨ envï¼ˆå…¨ç«™ä??´ï?

```env
PUBLIC_BASE_URL=https://ä½ ç?ä¸»å???LINUXDO_REDIRECT_URI=https://ä½ ç?ä¸»å???api/v1/auth/callback
REDIS_URL=rediss://...
COOKIE_SECURE=true
WORKER_ENABLED=true
```

### æ¯è??¹ä???
```env
WORKER_ID=node-01          # å¿…å¡«ä¸”å”¯ä¸€
NODE_LABEL=cn-east-1a      # ?¯é€‰ï?ç®¡ç??å°å±•ç¤º
NODE_REGION=cn-east        # ?¯é€?```

**ä¸è?**ç»™æ??°è®¾ä¸å???`PUBLIC_BASE_URL`?‚æ?ç«™ç›´è¿åœ°?€ï¼ˆIP:8787ï¼‰åª?™åœ¨ Cloudflare Worker ??`ORIGINS`ï¼Œè? `cloudflare-worker/README.md`??
### ?¨ç½²æ­¥éª¤?˜è?

1. ?„æœºï¼š`docker run ... --env-file .env -e WORKER_ID=node-0N -p 8787:8787 wechat-ai`  
2. ?ç½®å¹¶éƒ¨ç½?`cloudflare-worker`ï¼Œ`ORIGINS=http://ip1:8787,http://ip2:8787,...`  
3. ä¸»å??ç???Worker  
4. ?“å? `/admin` ??**?‚ç‚¹**ï¼šå??‹åˆ°??`WORKER_ID` å¿ƒè·³ä¸ç?çº?bot ?? 

| ?¢æ´» | è·¯å? |
|------|------|
| Docker / è½»é? | `GET /health` |
| LB å°±ç»ªï¼ˆå« Redisï¼?| `GET /health/ready` |

ç®¡ç? APIï¼š`GET /api/v1/admin/nodes`ï¼ˆCookie ç®¡ç??˜ï???
?«ç?? æœº?¨äººä¼šè??¶æ€åœ¨ Redisï¼ŒHTTP ? é?ç²˜æ€§ä?è¯ã€?
### ç§Ÿçº¦?ªåŠ¨?å¹³è¡¡ï?rebalanceï¼?
å¤šè??¹é?è®?**å¼€??*ï¼šç?çº¦å?å¤šç?è¿›ç?ä¼šå‘¨?Ÿæ€?**ä¸»åŠ¨?Šæ”¾** å¤šä? leaseï¼ˆä? pause botï¼‰ï?ç©ºé—²?‚ç‚¹ä¸‹ä?è½?`claim` ?¡èµ°ï¼Œä½¿?„è???bot ?°æ¥è¿‘å??†ã€?
| ?¯å??˜é? | é»˜è®¤ | è¯´æ? |
|----------|------|------|
| `REBALANCE_ENABLED` | `true` | è®¾ä¸º `false` ?³é—­ï¼ˆç?çº¦ç??¨é?? è??¹ï? |
| `REBALANCE_INTERVAL_SEC` | `60` | ?Œä?è¿›ç?ä¸¤æ¬¡ shed ?€å°é—´??|
| `REBALANCE_SLACK` | `2` | ?è®¸é«˜å‡º?‡å?å¤šå?ä¸ªå??Šæ”¾ |
| `REBALANCE_MAX_PER_TICK` | `50` | æ¯æ¬¡?€å¤šé??¾æ•°ï¼ˆé¿?ç¬?´ç©ºçª—è?å¤§ï? |

?¥å??³é”®å­—ï?`[worker] rebalance shed N bot(s)`?‚çº¦ `ceil(è¶…é? / 50)` ?†é??…æ”¶?›ã€?
### å¼ºåˆ¶ä¸‹çº¿?‚ç‚¹

ç®¡ç??å° **?‚ç‚¹** é¡???**å¼ºåˆ¶ä¸‹çº¿**ï¼?
1. ?™å…¥ Redis fenceï¼ˆ`wa:worker:{id}:fence`ï¼? 
2. ?Šæ”¾è¯?WORKER_ID ä¸‹å…¨??bot ç§Ÿçº¦  
3. ä»?`wa:workers:reg` ç§»é™¤  

?®æ?è¿›ç?ä¸‹ä?è½?reconcile ?‘ç° fence ?å?æ­¢è®¤é¢†ï??¶ä??‚ç‚¹ claim è¿™ä? bot?? 
**è§?™¤ä¸‹çº¿** ?è¯¥?‚ç‚¹?¯é??°å??¥ã€? 

è¿?*ä¸ä?** `docker stop`ï¼›è‹¥è¦ä? LB ?˜æ??ï?è¿˜è?ä»?Cloudflare Worker `ORIGINS` ?»æ?è¯¥æ?ç«™ã€