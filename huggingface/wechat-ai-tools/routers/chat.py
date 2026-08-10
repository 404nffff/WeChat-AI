from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from config import Settings, get_settings
from routers.deps import require_tools_auth
from services.upstream_llm import UpstreamLlmError, chat_completions

router = APIRouter(prefix="/v1", tags=["chat"])


@router.post("/chat/completions")
async def openai_chat_completions(
    request: Request,
    settings: Settings = Depends(get_settings),
    _: None = Depends(require_tools_auth),
) -> dict[str, Any]:
    """
    OpenAI-compatible chat completions proxy.

    Main site uses this for **user custom LLM APIs** by sending:
      { "messages": [...], "model": "...", "upstream": { "base_url", "api_key", "model" } }

    Without upstream, falls back to UPSTREAM_LLM_* on this service (optional).
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    if "messages" not in body:
        raise HTTPException(status_code=400, detail="messages is required")

    try:
        return await chat_completions(body, settings)
    except UpstreamLlmError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
