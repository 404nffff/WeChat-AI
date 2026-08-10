from __future__ import annotations

from fastapi import APIRouter

from config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    settings = get_settings()
    has_platform = bool(
        (settings.upstream_llm_base_url or "").strip()
        and (settings.upstream_llm_api_key or "").strip()
    )
    return {
        "ok": True,
        "service": "wechat-ai-tools",
        "auth_required": bool((settings.tools_api_key or "").strip()),
        "allow_request_upstream": settings.allow_request_upstream,
        "platform_upstream_configured": has_platform,
        "search_provider": settings.search_provider,
    }
