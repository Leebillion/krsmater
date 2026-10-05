"""Publish an output file as the KRS Master site's active master.

The site (master.mykrs.com, Node/Express) already has POST /api/master/import, which
parses the fixed-width file and replaces the master every user searches and scans
against. The editor calls it server to server with a shared token, so the site keeps
one import path and one parser.
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.request

from .settings import Settings

TOKEN_HEADER = "X-Editor-Token"
# Large masters (100k rows) take a while for the site to parse and store.
TIMEOUT_SECONDS = 300


class PublishError(Exception):
    pass


def _multipart(field: str, filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = f"----master-editor-{secrets.token_hex(12)}"
    # Raw UTF-8 filename: the site's normalizeUploadFileName() recovers Korean names
    # that multer reads as latin1.
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        "Content-Type: text/plain\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("ascii")
    return head + data + tail, f"multipart/form-data; boundary={boundary}"


def publish_master(settings: Settings, filename: str, data: bytes) -> dict:
    """Replace the site's active master with this file. Returns the site's summary."""
    if not settings.publish_enabled:
        raise PublishError("사이트 게시가 설정되지 않았습니다(SITE_API_URL, EDITOR_SHARED_TOKEN).")
    body, content_type = _multipart("masterFile", filename.replace('"', "_"), data)
    request = urllib.request.Request(
        f"{settings.site_api_url}/api/master/import",
        data=body,
        method="POST",
        headers={"Content-Type": content_type, TOKEN_HEADER: settings.site_publish_token},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", "")
        except (ValueError, AttributeError):
            pass
        raise PublishError(f"사이트가 게시를 거부했습니다({exc.code}). {detail}".strip()) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise PublishError(f"사이트 서버에 연결하지 못했습니다: {exc}") from exc
    summary = payload.get("summary") or {}
    if not payload.get("ok"):
        raise PublishError(payload.get("error") or "사이트가 알 수 없는 응답을 보냈습니다.")
    return summary
