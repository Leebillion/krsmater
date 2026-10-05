"""Shared-password login, signed session cookie, login throttling, CSRF guard."""

from __future__ import annotations

import hmac
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .state import AppState, SessionState

COOKIE_NAME = "mr_session"
# Browsers cannot add custom headers to cross-site form posts, so requiring one on
# every state-changing request blocks CSRF in addition to the SameSite cookie.
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "master-reducer"


class LoginThrottle:
    """Refuse further attempts from an address after too many recent failures."""

    def __init__(self, max_failures: int, window_seconds: int) -> None:
        self.max_failures = max_failures
        self.window = window_seconds
        self.failures: dict[str, deque[float]] = defaultdict(deque)

    def _recent(self, key: str) -> deque[float]:
        attempts = self.failures[key]
        cutoff = time.time() - self.window
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        return attempts

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.max_failures

    def record_failure(self, key: str) -> None:
        self._recent(key).append(time.time())

    def reset(self, key: str) -> None:
        self.failures.pop(key, None)


class Auth:
    def __init__(self, state: AppState) -> None:
        self.state = state
        settings = state.settings
        self.serializer = URLSafeTimedSerializer(settings.secret_key, salt="master-reducer-session")
        self.throttle = LoginThrottle(settings.login_max_failures, settings.login_window_minutes * 60)
        self.max_age = settings.session_ttl_hours * 3600

    @staticmethod
    def client_key(request: Request) -> str:
        # Behind the reverse proxy the peer is always 127.0.0.1; Caddy passes the real address.
        # Take the entry the proxy appended (the last), not one a client could have forged.
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[-1].strip()
        return request.client.host if request.client else "unknown"

    def check_password(self, password: str) -> bool:
        return hmac.compare_digest(password.encode("utf-8"), self.state.settings.password.encode("utf-8"))

    def login(self, request: Request, response: Response, password: str) -> SessionState:
        key = self.client_key(request)
        if self.throttle.blocked(key):
            raise HTTPException(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
        if not self.check_password(password):
            self.throttle.record_failure(key)
            raise HTTPException(401, "비밀번호가 올바르지 않습니다.")
        self.throttle.reset(key)
        session = self.state.new_session()
        response.set_cookie(
            COOKIE_NAME,
            self.serializer.dumps(session.sid),
            max_age=self.max_age,
            httponly=True,
            secure=self.state.settings.cookie_secure,
            samesite="strict",
            path="/",
        )
        return session

    def logout(self, request: Request, response: Response) -> None:
        sid = self._sid(request)
        if sid:
            self.state.drop_session(sid)
        response.delete_cookie(COOKIE_NAME, path="/")

    def _sid(self, request: Request) -> str | None:
        token = request.cookies.get(COOKIE_NAME)
        if not token:
            return None
        try:
            return self.serializer.loads(token, max_age=self.max_age)
        except (BadSignature, SignatureExpired):
            return None

    def is_logged_in(self, request: Request) -> bool:
        """Signed cookie for a live session, checked without the app lock (read-only)."""
        sid = self._sid(request)
        return bool(sid) and sid in self.state.sessions

    def session_for(self, request: Request) -> SessionState:
        sid = self._sid(request)
        session = self.state.get_session(sid) if sid else None
        if session is None:
            raise HTTPException(401, "로그인이 필요합니다. (서버가 다시 시작되었거나 오래 사용하지 않아 작업이 종료되었을 수 있습니다.)")
        if request.method not in ("GET", "HEAD") and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            raise HTTPException(403, "잘못된 요청입니다.")
        return session
