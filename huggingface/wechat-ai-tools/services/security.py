"""SSRF guards for upstream LLM base URLs."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUpstreamError(ValueError):
    pass


_BLOCKED_HOSTS = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
        "metadata",
    }
)


def _is_private_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def validate_upstream_base_url(url: str, *, deny_private: bool = True) -> str:
    """Return normalized base URL or raise UnsafeUpstreamError."""
    raw = (url or "").strip()
    if not raw:
        raise UnsafeUpstreamError("upstream base_url is empty")
    if len(raw) > 2048:
        raise UnsafeUpstreamError("upstream base_url too long")

    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUpstreamError("upstream base_url must be http(s)")
    if not parsed.hostname:
        raise UnsafeUpstreamError("upstream base_url missing host")
    if parsed.username or parsed.password:
        raise UnsafeUpstreamError("upstream base_url must not embed credentials")

    host = parsed.hostname.lower().rstrip(".")
    if host in _BLOCKED_HOSTS or host.endswith(".local"):
        raise UnsafeUpstreamError(f"upstream host not allowed: {host}")

    if deny_private:
        try:
            infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise UnsafeUpstreamError(f"upstream host resolve failed: {host}") from exc
        for info in infos:
            ip = info[4][0]
            if _is_private_ip(ip):
                raise UnsafeUpstreamError(
                    f"upstream resolves to blocked address: {host} -> {ip}"
                )

    # Normalize: no trailing slash (callers append /chat/completions)
    return raw.rstrip("/")
