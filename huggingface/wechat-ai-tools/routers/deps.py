from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import Settings, get_settings

_bearer = HTTPBearer(auto_error=False)


def require_tools_auth(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings),
) -> None:
    expected = (settings.tools_api_key or "").strip()
    if not expected:
        # Open mode (local demo only). Production should set TOOLS_API_KEY.
        return

    token = ""
    if creds and creds.scheme.lower() == "bearer":
        token = (creds.credentials or "").strip()
    if not token:
        token = (request.headers.get("x-api-key") or "").strip()

    if token != expected:
        raise HTTPException(status_code=401, detail="invalid or missing tools API key")
