# LINUX DO OAuth 接入

## 1. 申请应用

1. 打开 [LINUX DO Connect](https://connect.linux.do/)（或社区应用管理入口）
2. 创建 OAuth 应用，回调地址填：

```text
http://你的域名/api/v1/auth/callback
```

本地开发示例：

```text
http://127.0.0.1:8787/api/v1/auth/callback
```

3. 拿到 `client_id` / `client_secret`

## 2. 配置 `.env`

```env
LINUXDO_CLIENT_ID=...
LINUXDO_CLIENT_SECRET=...
LINUXDO_REDIRECT_URI=http://127.0.0.1:8787/api/v1/auth/callback
LINUXDO_ADMIN_IDS=你的LINUXDO数字ID,你的用户名
REDIS_URL=redis://:密码@远端:6379/0
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

`LINUXDO_ADMIN_IDS`：匹配 OAuth 返回的 **用户 id** 或 **username** 即视为管理员。

### 关闭 LINUX DO 登录

如需禁用 LINUX DO Connect 登录（仅保留用户名密码/邀请码）：

```env
LINUXDO_AUTH_ENABLED=false
```

- 前端（`/app`、`/admin`）隐藏「使用 LINUX DO 登录」按钮
- `/api/v1/auth/login` 与 `/api/v1/auth/callback` 一律返回 503
- 即使 `LINUXDO_CLIENT_ID/SECRET` 仍配置着也不生效
- 该开关可在 `/admin → 设置` 运行时切换，无需重启（`localAuthEnabled` 同理）

> 注意：如果**不重启服务**或浏览器/CDN 仍缓存旧的 `/api/v1/auth/config` 响应，
> 前端按钮可能不会立即消失。此接口现在返回 `no-store`，但请确保已重启进程、
> 并清除 Cloudflare 边缘缓存（`/api/v1/auth/config` 曾允许最长 5 分钟缓存）。
>
> **`linuxdoAuthEnabled` 是运行时设置**：`/admin → 设置` 页面存到 Redis 的
> 覆盖值会**优先于 `.env`**。若曾在该页把开关切到 `true`（或 Redis 残留旧值），
> 需回到 `/admin → 设置` 把它关闭（或「重置全部设置」），`.env` 的
> `LINUXDO_AUTH_ENABLED=false` 才会生效。

### 完全不用 LINUX DO：纯本地管理员

不配置/不启用 LINUX DO，仅用「用户名+密码」管理，方法如下：

```env
LINUXDO_AUTH_ENABLED=false
LOCAL_AUTH_ENABLED=true        # 用户名+密码登录（默认已开）
FIRST_USER_IS_ADMIN=true       # 首个注册用户自动成为管理员（默认）
LINUXDO_ADMIN_IDS=             # 留空，交给 FIRST_USER_IS_ADMIN 引导
```

**步骤**：

1. 按上面配置后启动服务
2. 打开 `/app` → **注册**（第一个注册用户因 `FIRST_USER_IS_ADMIN` 自动成为超管）
   - 若 `INVITE_REQUIRED_FOR_LOCAL=true` 且是第一个用户（库中尚无任何用户），
     `bootstrap` 逻辑会跳过邀请码要求，直接成为管理员
3. 用该账号登录 `/admin`，进入 **用户** 页即可给其他账号「授予管理员」

> `LINUXDO_ADMIN_IDS` 为空且首个本地用户注册时，`createLocalUser` 的
> `bootstrapAdmin` 分支（`firstUserIsAdmin && totalUsers===0 && adminIds.size===0`）
> 会将其标记为管理员——这就是纯本地部署下第一位管理员的来源。
> 之后新增管理员请在 `/admin → 用户` 手动授予。

## 3. 流程

1. 用户访问 `/app` → 可用 **用户名密码** 登录，或点「LINUX DO 登录」
2. LINUX DO 跳转 `connect.linux.do` 授权（scope：`openid profile`）
3. 回调 `/api/v1/auth/callback` 写 Redis session cookie  
   - **OAuth 新用户不需要邀请码**（与本地注册不同）
4. 本地注册：需好友分享的一次性邀请码/链接（`/app?invite=CODE`），成功后同样写 session cookie
5. 普通用户：管理自己的机器人（添加/删除、批准 peer、分配人设）、生成邀请
6. 管理员：`/admin` 仪表盘；可配置「每 X 小时可生成 N 个邀请」、封禁/删除用户、停用/删除机器人

未配置 `LINUXDO_ADMIN_IDS` 时，**第一个成功注册/登录的用户**自动成为管理员（`FIRST_USER_IS_ADMIN=true`）。

封禁用户后 OAuth 仍可在 LINUX DO 授权，但 callback / 密码登录 / 会话校验会返回 `user_banned`。

## 4. 协议端点（默认 / OIDC Discovery）

| 用途 | URL |
|------|-----|
| Discovery | `https://connect.linux.do/.well-known/openid-configuration` |
| 授权 | `https://connect.linux.do/oauth2/authorize` |
| Token | `https://connect.linux.do/oauth2/token` |
| 用户信息 | `https://connect.linux.do/api/user` |
| 支持 scope | `openid` `profile` `email` |
