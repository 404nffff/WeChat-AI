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
