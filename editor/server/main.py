"""FastAPI application: API, static front end, security headers.

Run (single worker -- sessions live in memory):
    uvicorn server.main:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager

from .settings import PROJECT_ROOT, WEB_APP_DIR, Settings, load_settings

# The domain logic lives in the desktop app's package next to web_app/.
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

from .api import build_router  # noqa: E402
from .auth import COOKIE_NAME, Auth  # noqa: E402
from .state import AppState  # noqa: E402

STATIC_DIR = WEB_APP_DIR / "static"

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        # 'self': the KRS Master site embeds this app in its '마스터 편집' menu (same origin).
        "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    state = AppState(settings)
    auth = Auth(state)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        state.close()

    app = FastAPI(
        title="상품 마스터 용량 축소", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )
    app.state.app_state = state
    app.include_router(build_router(state, auth))

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException):
        return JSONResponse({"ok": False, "message": exc.detail}, status_code=exc.status_code)

    @app.get("/", include_in_schema=False)
    async def index(request: Request):
        # 로그인 쿠키가 없으면 로그인 화면부터 보여 준다(쿠키 검증은 API가 한다).
        # 상대 경로라 /editor/ 같은 접두어 아래에서도 /editor/login으로 간다.
        if not request.cookies.get(COOKIE_NAME):
            return RedirectResponse("login")
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/login", include_in_schema=False)
    async def login_page():
        return FileResponse(STATIC_DIR / "login.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app

