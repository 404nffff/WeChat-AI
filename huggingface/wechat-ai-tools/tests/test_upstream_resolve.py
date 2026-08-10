import pytest

from config import Settings
from services.upstream_llm import UpstreamLlmError, resolve_upstream


def test_request_upstream():
    settings = Settings(
        ALLOW_REQUEST_UPSTREAM=True,
        UPSTREAM_DENY_PRIVATE=False,
        UPSTREAM_LLM_API_KEY="",
    )
    base, key, model = resolve_upstream(
        {
            "model": "ignored-if-upstream-has-model",
            "upstream": {
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-test",
                "model": "my-model",
            },
        },
        settings,
    )
    assert base == "https://api.example.com/v1"
    assert key == "sk-test"
    assert model == "my-model"


def test_platform_fallback():
    settings = Settings(
        ALLOW_REQUEST_UPSTREAM=True,
        UPSTREAM_DENY_PRIVATE=False,
        UPSTREAM_LLM_BASE_URL="https://platform.example/v1",
        UPSTREAM_LLM_API_KEY="sk-platform",
        UPSTREAM_LLM_MODEL="gpt-mini",
    )
    base, key, model = resolve_upstream({"messages": []}, settings)
    assert "platform.example" in base
    assert key == "sk-platform"
    assert model == "gpt-mini"


def test_missing_platform_raises():
    settings = Settings(
        ALLOW_REQUEST_UPSTREAM=True,
        UPSTREAM_LLM_API_KEY="",
        UPSTREAM_DENY_PRIVATE=False,
    )
    with pytest.raises(UpstreamLlmError):
        resolve_upstream({"messages": []}, settings)
