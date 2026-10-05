"""Runtime settings, all from environment variables (never hard-code the password)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

WEB_APP_DIR = Path(__file__).resolve().parent.parent
# The rules package (master_reducer) sits next to web_app/ in the desktop project, but
# is bundled inside the editor folder when deployed with the KRS Master site.
PROJECT_ROOT = WEB_APP_DIR if (WEB_APP_DIR / "master_reducer").is_dir() else WEB_APP_DIR.parent


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    password: str
    secret_key: str
    data_dir: Path
    seed_db: Path | None
    max_upload_mb: int
    session_ttl_hours: int
    cookie_secure: bool
    login_max_failures: int
    login_window_minutes: int
    # KRS Master site (master.mykrs.com) API that the '사이트 현재 마스터로 게시' option
    # replaces the active master through. Publishing is off unless both are set.
    site_api_url: str = ""
    site_publish_token: str = ""

    @property
    def publish_enabled(self) -> bool:
        return bool(self.site_api_url and self.site_publish_token)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "master_management.db"

    @property
    def sessions_dir(self) -> Path:
        return self.data_dir / "sessions"

    @property
    def template_path(self) -> Path:
        return self.data_dir / "integrated_template.xlsx"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def load_settings() -> Settings:
    password = os.environ.get("APP_PASSWORD", "")
    if not password:
        raise RuntimeError(
            "APP_PASSWORD 환경변수가 비어 있습니다. 접속 비밀번호를 설정한 뒤 실행하세요."
        )
    # Without a fixed SECRET_KEY, every restart signs cookies with a new key and logs
    # everyone out -- acceptable, but set one in production.
    secret_key = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(48)
    data_dir = Path(os.environ.get("DATA_DIR") or (WEB_APP_DIR / "data")).resolve()
    seed = os.environ.get("SEED_DB")
    return Settings(
        password=password,
        secret_key=secret_key,
        data_dir=data_dir,
        seed_db=Path(seed).resolve() if seed else None,
        max_upload_mb=int(os.environ.get("MAX_UPLOAD_MB", "50")),
        session_ttl_hours=int(os.environ.get("SESSION_TTL_HOURS", "12")),
        cookie_secure=_flag("COOKIE_SECURE", True),
        login_max_failures=int(os.environ.get("LOGIN_MAX_FAILURES", "5")),
        login_window_minutes=int(os.environ.get("LOGIN_WINDOW_MINUTES", "10")),
        site_api_url=os.environ.get("SITE_API_URL", "").rstrip("/"),
        site_publish_token=os.environ.get("EDITOR_SHARED_TOKEN", ""),
    )
