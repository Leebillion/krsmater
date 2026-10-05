"""API tests: auth, uploads, reduction, products, outputs (FastAPI TestClient)."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

WEB_APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WEB_APP))
sys.path.insert(0, str(WEB_APP.parent))

from master_reducer.core import compose_fixed_width_row  # noqa: E402
from master_reducer.db import CATEGORY_TOBACCO, save_category_master_lines  # noqa: E402
from server.main import create_app  # noqa: E402
from server.settings import Settings  # noqa: E402

import dataclasses  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

PASSWORD = "test-password"
HEADERS = {"X-Requested-With": "master-reducer"}

TOBACCO = compose_fixed_width_row("8801111111111", "담배에쎄", "에쎄")
FF = compose_fixed_width_row("8802222222222", "도시락1편", "도시락")
GENERAL = compose_fixed_width_row("8803333333333", "일반상품", "일반")


def master_bytes(*rows: bytes) -> bytes:
    return b"".join(row + b"\r\n" for row in rows)


def make_settings(tmp_path: Path, **overrides) -> Settings:
    settings = Settings(
        password=PASSWORD,
        secret_key="test-secret",
        data_dir=tmp_path / "data",
        seed_db=None,
        max_upload_mb=1,
        session_ttl_hours=1,
        cookie_secure=False,
        login_max_failures=3,
        login_window_minutes=10,
    )
    return dataclasses.replace(settings, **overrides)


@pytest.fixture()
def app(tmp_path: Path):
    application = create_app(make_settings(tmp_path))
    save_category_master_lines(application.state.app_state.con, CATEGORY_TOBACCO, [TOBACCO])
    return application


def login(app) -> TestClient:
    client = TestClient(app)
    response = client.post("/api/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return client


def upload(client: TestClient, slot: str, data: bytes, name: str = "h140100003_new_01_20260831.txt"):
    return client.post(f"/api/files/{slot}", files={"file": (name, data)}, headers=HEADERS)


def test_api_requires_login(app):
    client = TestClient(app)
    assert client.get("/api/state").status_code == 401
    # 상대 경로: /editor/ 같은 접두어 아래에서도 /editor/login으로 간다.
    assert client.get("/", follow_redirects=False).headers["location"] == "login"
    assert client.get("/api/me").status_code == 401


def test_wrong_password_is_throttled(app):
    client = TestClient(app)
    for _ in range(3):
        assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 429


def test_state_changing_request_needs_csrf_header(app):
    client = login(app)
    response = client.post("/api/reduce/apply-saved")
    assert response.status_code == 403


def test_security_headers_present(app):
    response = TestClient(app).get("/login")
    assert "default-src 'self'" in response.headers["content-security-policy"]
    # 같은 도메인(KRS Master 사이트의 '마스터 편집' 메뉴)에서만 화면 안에 넣을 수 있다.
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]


def test_upload_reduce_and_download_outputs(app):
    client = login(app)
    assert upload(client, "new", master_bytes(TOBACCO, FF, GENERAL)).json()["ok"]

    rows = client.get("/api/rows/all").json()
    assert rows["total"] == 3
    general_key = next(r["key"] for r in rows["rows"] if r["barcode"] == "8803333333333")

    result = client.post("/api/reduce/delete", json={"tab": "all", "keys": [general_key]}, headers=HEADERS).json()
    assert result["ok"] and result["count"] == 1
    assert client.get("/api/state").json()["excluded"] == 1

    options = client.get("/api/outputs/options").json()
    assert options["prefix"] == "new_01_20260831"
    plans = [
        {"key": o["key"], "enabled": o["available"], "appends": o["default_appends"]}
        for o in options["outputs"]
    ]
    plan = client.post("/api/outputs/plan", json={"plans": plans, "prefix": options["prefix"]}, headers=HEADERS).json()
    by_key = {o["key"]: o for o in plan["outputs"]}
    # 팀장용: 담배 유지, FF 자동 제외, 일반 상품은 감축으로 빠짐
    assert by_key["leader"]["total"] == 1
    assert by_key["leader"]["filename"] == "1_new_01_20260831_팀장용.txt"

    saved = client.post(
        "/api/outputs/save",
        json={"plans": [dict(p, filename=by_key[p["key"]]["filename"]) for p in plans if p["enabled"]],
              "prefix": options["prefix"]},
        headers=HEADERS,
    ).json()
    assert saved["ok"], saved
    archive = zipfile.ZipFile(io.BytesIO(client.get(saved["download"]).content))
    leader = archive.read("1_new_01_20260831_팀장용.txt")
    assert leader == TOBACCO + b"\r\n"
    member = archive.read(next(n for n in archive.namelist() if n.endswith("팀원용.txt")))
    assert member == FF + b"\r\n"


def test_sessions_are_separate_but_db_is_shared(app):
    first = login(app)
    second = login(app)
    upload(first, "new", master_bytes(TOBACCO, FF, GENERAL))
    first.post("/api/reduce/delete-tobacco", headers=HEADERS)

    assert second.get("/api/state").json()["excluded"] == 0
    # 담배 일괄 삭제 기록(공유 DB)은 다른 사용자에게도 보인다.
    assert second.get("/api/rows/tobacco_deleted").json()["total"] == 1


def test_product_row_duplicate_needs_overwrite(app):
    client = login(app)
    body = {"barcode": "2800000000001", "long_name": "종량제봉투5L", "short_name": "종량제5L"}
    assert client.post("/api/products/paid/row", json=body, headers=HEADERS).json()["ok"]
    duplicate = client.post("/api/products/paid/row", json=body, headers=HEADERS).json()
    assert duplicate["duplicate"] and not duplicate["ok"]
    assert client.post("/api/products/paid/row", json=dict(body, overwrite=True), headers=HEADERS).json()["ok"]
    rows = client.get("/api/rows/paid").json()
    assert [r["barcode"] for r in rows["rows"]] == ["2800000000001"]


def test_upload_size_limit(app):
    client = login(app)
    response = upload(client, "new", b"0" * (1024 * 1024 + 10))
    assert response.status_code == 413


def test_pda_short_downloads_as_master_txt(app):
    client = login(app)
    upload(client, "short", master_bytes(GENERAL), name="short.txt")
    options = client.get("/api/outputs/options").json()
    pda = next(o for o in options["outputs"] if o["key"] == "pda_short")
    assert pda["available"] and pda["fixed_filename"] == "master.txt"
    saved = client.post(
        "/api/outputs/save",
        json={"plans": [{"key": "pda_short", "appends": [], "filename": "master.txt"}], "prefix": "x"},
        headers=HEADERS,
    ).json()
    archive = zipfile.ZipFile(io.BytesIO(client.get(saved["download"]).content))
    assert archive.namelist() == ["master.txt"]


def test_filename_cannot_escape_the_archive(app):
    client = login(app)
    upload(client, "new", master_bytes(GENERAL))
    saved = client.post(
        "/api/outputs/save",
        json={"plans": [{"key": "leader", "appends": [], "filename": "../../evil.txt"}], "prefix": "x"},
        headers=HEADERS,
    ).json()
    archive = zipfile.ZipFile(io.BytesIO(client.get(saved["download"]).content))
    assert archive.namelist() == ["evil.txt"]


def test_me_reports_login(app):
    client = login(app)
    assert client.get("/api/me").json() == {"ok": True, "admin": True}


class FakeSite(BaseHTTPRequestHandler):
    """Stands in for the KRS Master site's POST /api/master/import."""

    received: list = []

    def do_POST(self):  # noqa: N802 - http.server API
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeSite.received.append((self.path, self.headers.get("X-Editor-Token"), body))
        ok = self.headers.get("X-Editor-Token") == "shared-token"
        payload = {"ok": True, "summary": {"fileName": "published.txt", "recordCount": 1}} if ok else {"error": "관리자 로그인이 필요합니다."}
        data = json.dumps(payload).encode()
        self.send_response(200 if ok else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


@pytest.fixture()
def fake_site():
    FakeSite.received = []
    server = HTTPServer(("127.0.0.1", 0), FakeSite)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_publish_sends_the_output_to_the_site(tmp_path, fake_site):
    application = create_app(make_settings(tmp_path, site_api_url=fake_site, site_publish_token="shared-token"))
    client = login(application)
    assert client.get("/api/outputs/options").json()["publish_enabled"] is True
    upload(client, "new", master_bytes(GENERAL))

    saved = client.post(
        "/api/outputs/save",
        json={"plans": [{"key": "leader", "appends": [], "filename": "1_x_팀장용.txt"}], "prefix": "x", "publish": "leader"},
        headers=HEADERS,
    ).json()

    assert saved["published"]["ok"], saved
    path, token, body = FakeSite.received[0]
    assert path == "/api/master/import" and token == "shared-token"
    assert b'name="masterFile"' in body and GENERAL in body
    assert any("사이트 현재 마스터 게시" in line for line in saved["summary"])


def test_publish_failure_keeps_the_download(tmp_path, fake_site):
    application = create_app(make_settings(tmp_path, site_api_url=fake_site, site_publish_token="wrong-token"))
    client = login(application)
    upload(client, "new", master_bytes(GENERAL))

    saved = client.post(
        "/api/outputs/save",
        json={"plans": [{"key": "leader", "appends": [], "filename": "a.txt"}], "prefix": "x", "publish": "leader"},
        headers=HEADERS,
    ).json()

    assert saved["ok"] and not saved["published"]["ok"]
    assert "401" in saved["published"]["error"]
    assert client.get(saved["download"]).status_code == 200


def test_publish_is_off_without_configuration(app):
    client = login(app)
    assert client.get("/api/outputs/options").json()["publish_enabled"] is False
