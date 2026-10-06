"""Replace the shared product DB with a master_management.db uploaded from the PC app.

The desktop app and the web editor use the same SQLite schema, so the PC file can
become the server's DB as is. The upload is checked first (SQLite, intact, has the
product tables), the current DB is backed up, and then the upload is copied into
the live connection with SQLite's backup API -- no file swap under an open
connection, no server restart.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from master_reducer.db import ensure_schema

SQLITE_HEADER = b"SQLite format 3\x00"
# A PC master_management.db always has these; newer tables (service_master,
# search_preset, ...) are created by ensure_schema() if an older file lacks them.
REQUIRED_TABLES = ("paid_master", "bundle_master", "deleted_template", "category_master")
COUNTED_TABLES = (
    ("paid_master", "종량제"),
    ("bundle_master", "번들"),
    ("short_master", "단축상품"),
    ("service_master", "서비스"),
    ("deleted_template", "삭제한 행"),
    ("category_master", "담배+담배보루"),
    ("category_deleted_row", "삭제된 담배행"),
    ("search_preset", "검색어"),
)
KEEP_BACKUPS = 10


class DbSyncError(Exception):
    pass


def table_counts(con: sqlite3.Connection) -> dict[str, int | None]:
    existing = {row[0] for row in con.execute("select name from sqlite_master where type = 'table'")}
    return {
        label: (con.execute(f"select count(*) from {table}").fetchone()[0] if table in existing else None)
        for table, label in COUNTED_TABLES
    }


def open_upload(path: Path) -> sqlite3.Connection:
    """Open the uploaded file read-only after checking it is an intact product DB."""
    with path.open("rb") as handle:
        if handle.read(len(SQLITE_HEADER)) != SQLITE_HEADER:
            raise DbSyncError("SQLite DB 파일이 아닙니다. PC 앱 폴더의 master_management.db를 올려 주세요.")
    # immutable=1: our private copy, possibly in WAL mode without its -shm file.
    con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    try:
        result = con.execute("pragma integrity_check").fetchone()[0]
        if result != "ok":
            raise DbSyncError(f"DB 파일이 손상되었습니다: {result}")
        tables = {row[0] for row in con.execute("select name from sqlite_master where type = 'table'")}
        missing = [table for table in REQUIRED_TABLES if table not in tables]
        if missing:
            raise DbSyncError("상품 DB가 아닙니다(필요한 표 없음: " + ", ".join(missing) + ").")
    except sqlite3.DatabaseError as exc:
        con.close()
        raise DbSyncError(f"DB 파일을 읽을 수 없습니다: {exc}") from exc
    except DbSyncError:
        con.close()
        raise
    return con


def backup_current(con: sqlite3.Connection, backups_dir: Path) -> Path:
    backups_dir.mkdir(parents=True, exist_ok=True)
    target = backups_dir / f"master_management_{datetime.now():%Y%m%d_%H%M%S}.db"
    destination = sqlite3.connect(target)
    try:
        con.backup(destination)
    finally:
        destination.close()
    for old in sorted(backups_dir.glob("master_management_*.db"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)
    return target


def replace_shared_db(con: sqlite3.Connection, upload_path: Path, backups_dir: Path) -> dict:
    source = open_upload(upload_path)
    try:
        before = table_counts(con)
        backup = backup_current(con, backups_dir)
        try:
            source.backup(con)
        except sqlite3.Error as exc:
            raise DbSyncError(f"DB를 교체하지 못했습니다(기존 DB는 그대로입니다): {exc}") from exc
    finally:
        source.close()
    con.execute("pragma journal_mode=wal")
    ensure_schema(con)
    return {"before": before, "after": table_counts(con), "backup": backup.name}
