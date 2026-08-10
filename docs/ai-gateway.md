# AI 网关：平台 LLM vs 用户自定义 / 搜索

## 原则

| 流量 | 出站位置 |
|------|----------|
| **管理员配置的平台 LLM**（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`） | **主站直连** |
| **用户自定义 OpenAI 兼容 API** | **仅** `huggingface/wechat-ai-tools`（HF / Docker） |
| **联网搜索** | **仅** tools 服务 |

主站 Node 进程**不会** `fetch(用户的 base_url)`，也不会直连搜索引擎。

```
主站 ──平台 LLM──► 管理员配置的上游
  │
  └──TOOLS_BASE_URL──► wechat-ai-tools
                          ├── /v1/chat/completions + body.upstream ──► 用户 API
                          └── /v1/web-search ──► DDG / SearXNG / …
```

## 主站环境变量

```env
# 平台（管理员）
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# 工具网关
TOOLS_BASE_URL=http://127.0.0.1:7860   # 或 https://xxx.hf.space
TOOLS_API_KEY=shared-secret
WEB_SEARCH_ENABLED=true
LLM_PROVIDER_SECRET=...                # 加密用户保存的 API Key
```

## 打包 tools 镜像

```bash
# 在 tools 目录
docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools

# 或 compose profile
docker compose --profile tools up -d --build
# 主站 .env 使用：TOOLS_BASE_URL=http://wechat-ai-tools:7860
```

详见 `huggingface/wechat-ai-tools/README.md`。

## Chatflow

编排图中的 `llm` / `search` / `http` 同样遵守上表：用户自定义与搜索只经 tools；`http` 节点默认仅 tools host。见 `docs/chatflow.md`。

## 诊断

```bash
pnpm diag
```

会检查平台 `LLM_API_KEY`，以及（若配置了）`TOOLS_BASE_URL/health`。
