import pytest

from services.security import UnsafeUpstreamError, validate_upstream_base_url


def test_accepts_https_public_host():
    # deny_private still resolves DNS; use example.com which is public
    url = validate_upstream_base_url(
        "https://example.com/v1/",
        deny_private=False,
    )
    assert url == "https://example.com/v1"


def test_rejects_localhost():
    with pytest.raises(UnsafeUpstreamError):
        validate_upstream_base_url("http://localhost:8080/v1", deny_private=True)


def test_rejects_non_http():
    with pytest.raises(UnsafeUpstreamError):
        validate_upstream_base_url("ftp://example.com/v1", deny_private=False)


def test_rejects_embedded_credentials():
    with pytest.raises(UnsafeUpstreamError):
        validate_upstream_base_url(
            "https://user:pass@example.com/v1",
            deny_private=False,
        )
