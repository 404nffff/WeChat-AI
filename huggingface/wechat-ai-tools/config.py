"""Runtime configuration for wechat-ai-tools (HF / Docker)."""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    tools_api_key: str = Field(default="", alias="TOOLS_API_KEY")

    upstream_llm_base_url: str = Field(
        default="https://api.openai.com/v1",
        alias="UPSTREAM_LLM_BASE_URL",
    )
    upstream_llm_api_key: str = Field(default="", alias="UPSTREAM_LLM_API_KEY")
    upstream_llm_model: str = Field(default="gpt-4o-mini", alias="UPSTREAM_LLM_MODEL")

    allow_request_upstream: bool = Field(default=True, alias="ALLOW_REQUEST_UPSTREAM")
    upstream_deny_private: bool = Field(default=True, alias="UPSTREAM_DENY_PRIVATE")
    upstream_timeout_ms: int = Field(default=60_000, alias="UPSTREAM_TIMEOUT_MS")
    max_body_bytes: int = Field(default=1_048_576, alias="MAX_BODY_BYTES")

    search_provider: str = Field(default="ddg", alias="SEARCH_PROVIDER")
    searxng_url: str = Field(default="", alias="SEARXNG_URL")
    tavily_api_key: str = Field(default="", alias="TAVILY_API_KEY")
    search_timeout_ms: int = Field(default=15_000, alias="SEARCH_TIMEOUT_MS")
    search_max_results: int = Field(default=8, alias="SEARCH_MAX_RESULTS")

    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=7860, alias="PORT")
    log_level: str = Field(default="info", alias="LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
