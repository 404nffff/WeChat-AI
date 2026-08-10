from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from config import Settings, get_settings
from routers.deps import require_tools_auth
from services.web_search import SearchError, search_web

router = APIRouter(prefix="/v1", tags=["search"])


class WebSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    max_results: int | None = Field(default=None, ge=1, le=10)


@router.post("/web-search")
async def web_search(
    body: WebSearchRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    _: None = Depends(require_tools_auth),
) -> dict[str, Any]:
    _ = request
    try:
        results = await search_web(
            body.query,
            max_results=body.max_results,
            settings=settings,
        )
    except SearchError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"query": body.query.strip(), "results": results}
