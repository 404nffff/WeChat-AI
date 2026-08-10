"""
wechat-ai-tools — AI gateway for WeChat-AI user custom LLM + web search.

Platform (admin) LLM is called by the main site directly.
User-configured custom APIs and web search egress through this service.

Deploy: Docker image / Hugging Face Spaces (Docker).
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import get_settings
from routers import chat, health, search

settings = get_settings()
logging.basicConfig(
    level=getattr(logging, (settings.log_level or "info").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("wechat-ai-tools")

app = FastAPI(
    title="wechat-ai-tools",
    description=(
        "HTTP tools gateway for WeChat-AI: web search + proxy for user custom "
        "OpenAI-compatible LLM APIs. Platform LLM stays on the main site."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(search.router)
app.include_router(chat.router)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > settings.max_body_bytes:
        return JSONResponse(
            status_code=413,
            content={"detail": "request body too large"},
        )
    return await call_next(request)


@app.get("/")
async def root() -> dict:
    return {
        "service": "wechat-ai-tools",
        "docs": "/docs",
        "health": "/health",
        "endpoints": [
            "POST /v1/web-search",
            "POST /v1/chat/completions",
        ],
        "note": (
            "Main site uses platform LLM directly; user custom APIs and search "
            "go through this gateway."
        ),
    }


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        log_level=(settings.log_level or "info").lower(),
    )


if __name__ == "__main__":
    main()
