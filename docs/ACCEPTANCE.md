# 验收状态

**日期**：2026-07-19  
**结论**：**系统已完成并可验收**（离线/自动化门禁 + 文档化真机清单）

## 已交付范围（v1）

| 能力 | 实现 |
|------|------|
| 直连 iLink（无 OpenClaw） | `packages/ilink` |
| 多用户隔离会话/记忆 | `packages/core` + DB |
| 人设模板与发布 | seed 猫娘/女友 + Admin/API |
| 仅后台分配角色 | `/角色` 拒绝自助 |
| OpenAI 兼容 LLM | `packages/llm` |
| 多 Bot 登录 | `pnpm ilink:login -- --name …` |
| Admin Web | `/admin` |
| 限流 / typing / 非文字提示 | worker |
| 语音转写文本（有则用） | `extractText` |
| 运维 | `pnpm diag`、`docs/runbook.md` |
| E2E 清单 | `docs/e2e-checklist.md` |

## 自动化门禁

```bash
pnpm accept
```

包含：全仓单元测试、migrate/seed、diag、关键文件存在性。

## 真机项（人工）

见 `docs/e2e-checklist.md` 章节 C–E（需扫码 + 真实 LLM Key）。

## 非目标 / 可选后续

- ~~图片/文件 CDN 加解密全链路 / 入站 Vision~~ → **入站图片已实现**（CDN 下载 + AES-128-ECB 解密 + 视觉模型，`VISION_ENABLED`，默认关）。仍未做：入站语音 ASR（微信 SILK/AMR 无 OpenAI 兼容端点可用，现依赖 iLink 自带转写）、入站文件解析  
- Embedding 记忆检索（无 Embedding API；已用文本 top-k 替代）  
- 多模型路由  
- 联网搜索工具  
- React 工程化 Admin  
- Windows 服务安装包  
- 固定时段问候（可叠在主动联系调度器上）  

## 已补充（2026-07-20）

- 无向量记忆 top-k（`MEMORY_TOP_K` / `MEMORY_FULL_INJECT_MAX`）+ 条数上限/去重  
- 记忆治理：单条删除 + 用户中心「记忆」面板  
- `get_current_time` 工具（`TIME_TOOL_ENABLED`，默认开）  

## 主动找用户（空闲）

- 全局 `PROACTIVE_ENABLED` + Bot 开关 + peer「允许主动」  
- LLM 生成；可 skip；见 `docs/runbook.md` §2.1 

## AI 网关 + Chatflow（2026-07-26）

| 能力 | 实现 |
|------|------|
| 唯一外网 AI 出口 | `huggingface/wechat-ai-tools`（FastAPI + Dockerfile） |
| 用户自定义 OpenAI 兼容 API | 加密存储；**仅** HF 代发，主站不 dial 用户 base_url |
| 联网搜索 | 仅 HF `/v1/web-search`；全局 + 人设双开关 |
| 「我的模型」UI | `/app` → 我的模型（增删改 / 启停 / 掩码 Key） |
| Chatflow 引擎 | `packages/core/src/chatflow/*`；节点 start/llm/answer/if-else/http/memory/search |
| Chatflow 编辑器 | `/chatflow`（拖拽 + 连线 + 属性 + 保存启用） |
| 试聊支持 chatflow | 强制平台上游，不消耗作者额度 |
| 就绪探针 | `/health/ready` 纳入 tools 健康（缓存 15s） |

约束：chatflow 不做主动联系；Fork 不继承作者密钥；http 节点默认仅工具域。

文档：`docs/ai-gateway.md`、`docs/chatflow.md`；验收项见 `docs/e2e-checklist.md` §I / §J。
