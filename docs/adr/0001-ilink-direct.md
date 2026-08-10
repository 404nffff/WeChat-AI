# ADR-0001: 直连 iLink，不依赖 OpenClaw Gateway

## Status

Accepted (2026-07-19)

## Context

产品需要接入微信 ClawBot / OpenClaw 生态下的官方通道，并支持多人角色扮演。  
曾考虑以 OpenClaw Gateway + `@tencent-weixin/openclaw-weixin` 为运行时。

## Decision

**本系统直接调用腾讯 iLink Bot HTTP API**（`https://ilinkai.weixin.qq.com`）：

- 扫码登录拿 `bot_token`
- `getupdates` 长轮询收消息
- `sendmessage` 回复（必带 `context_token`）

会话、人设、记忆、LLM 均在本仓库实现。OpenClaw **不是运行时依赖**。

## Consequences

- 运维更轻：只需本服务 + LLM Key  
- 需自行维护 iLink 适配与协议变更  
- 多人隔离用 DB 行级 `(bot_account_id, peer_id[, persona_id])` 即可  
- 协议细节以 PR0 实测与官方插件行为为准；社区文档可能滞后  

## References

- OpenClaw WeChat channel docs (plugin path)  
- Community iLink protocol notes / `@tencent-weixin/openclaw-weixin` behavior  
