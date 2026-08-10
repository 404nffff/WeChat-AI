"""Proxy chat completions to an OpenAI-compatible upstream."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from config import Settings
from services.security import UnsafeUpstreamError, validate_upstream_base_url

log = logging.getLogger("wechat-ai-tools.llm")


class UpstreamLlmError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def resolve_upstream(
    body: dict[str, Any],
    settings: Settings,
) -> tuple[str, str, str]:
    """
    Returns (base_url, api_key, model).
    Prefer body.upstream when allowed; else platform defaults.
    """
    upstream = body.get("upstream")
    model_from_body = body.get("model")

    if isinstance(upstream, dict) and settings.allow_request_upstream:
        base = str(upstream.get("base_url") or upstream.get("baseUrl") or "").strip()
        key = str(upstream.get("api_key") or upstream.get("apiKey") or "").strip()
        model = str(
            upstream.get("model")
            or model_from_body
            or settings.upstream_llm_model
            or ""
        ).strip()
        if not base or not key:
            raise UpstreamLlmError(
                "upstream.base_url and upstream.api_key are required",
                status_code=400,
            )
        try:
            base = validate_upstream_base_url(
                base, deny_private=settings.upstream_deny_private
            )
        except UnsafeUpstreamError as exc:
            raise UpstreamLlmError(str(exc), status_code=400) from exc
        if not model:
            raise UpstreamLlmError("model is required", status_code=400)
        host = base.split("://", 1)[-1].split("/", 1)[0]
        log.info("upstream mode=request host=%s model=%s", host, model)
        return base, key, model

    if isinstance(upstream, dict) and not settings.allow_request_upstream:
        raise UpstreamLlmError(
            "per-request upstream is disabled on this tools instance",
            status_code=403,
        )

    base = (settings.upstream_llm_base_url or "").strip()
    key = (settings.upstream_llm_api_key or "").strip()
    model = str(model_from_body or settings.upstream_llm_model or "").strip()
    if not base or not key:
        raise UpstreamLlmError(
            "platform upstream not configured (UPSTREAM_LLM_BASE_URL / API_KEY)",
            status_code=503,
        )
    try:
        base = validate_upstream_base_url(
            base, deny_private=settings.upstream_deny_private
        )
    except UnsafeUpstreamError as exc:
        raise UpstreamLlmError(str(exc), status_code=500) from exc
    if not model:
        raise UpstreamLlmError("model is required", status_code=400)
    host = base.split("://", 1)[-1].split("/", 1)[0]
    log.info("upstream mode=platform host=%s model=%s", host, model)
    return base, key, model


def _strip_gateway_fields(body: dict[str, Any]) -> dict[str, Any]:
    """Remove fields that must not be forwarded to real providers."""
    out = dict(body)
    out.pop("upstream", None)
    return out


async def chat_completions(
    body: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    base_url, api_key, model = resolve_upstream(body, settings)
    payload = _strip_gateway_fields(body)
    payload["model"] = model

    url = f"{base_url}/chat/completions"
    timeout = max(1.0, settings.upstream_timeout_ms / 1000.0)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "wechat-ai-tools/1.0",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        raise UpstreamLlmError("upstream LLM timeout", status_code=504) from exc
    except httpx.RequestError as exc:
        log.warning("upstream request error: %s", type(exc).__name__)
        raise UpstreamLlmError(
            f"upstream request failed: {type(exc).__name__}",
            status_code=502,
        ) from exc

    if resp.status_code >= 400:
        # Do not leak upstream auth details
        snippet = (resp.text or "")[:300]
        log.warning("upstream HTTP %s body_len=%s", resp.status_code, len(resp.text or ""))
        raise UpstreamLlmError(
            f"upstream LLM error HTTP {resp.status_code}: {snippet}",
            status_code=502 if resp.status_code >= 500 else 400,
        )

    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise UpstreamLlmError("upstream returned non-JSON", status_code=502) from exc
    if not isinstance(data, dict):
        raise UpstreamLlmError("upstream returned invalid JSON object", status_code=502)
    return data
