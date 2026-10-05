"""Shared DB connection and per-browser work sessions.

Every request runs under one process-wide lock: the SQLite connection and the
in-memory sessions are shared, and the workloads are small (a handful of users),
so serialising is simpler and safer than fine-grained locking. This also means the
server must run with a single worker process (sessions live in memory).
"""

from __future__ import annotations

import secrets
import shutil
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from master_reducer.core import MasterLine
from master_reducer.db import WorkbookTarget, ensure_schema
from master_reducer.workspace import WorkSession

from .settings import Settings


@dataclass
class ImportPreview:
    source_key: str
    file_name: str
    lines: list[MasterLine]
    existing: set[str]


@dataclass
class WorkbookPreview:
    file_name: str
    targets: list[WorkbookTarget]
    current_counts: dict[str, int]


@dataclass
class SessionState:
    sid: str
    work: WorkSession
    directory: Path
    last_seen: float = field(default_factory=time.time)
    import_preview: ImportPreview | None = None
    workbook_preview: WorkbookPreview | None = None
    downloads: dict[str, Path] = field(default_factory=dict)
    # Bumped by every change to rows, so cached sorted/filtered tab lists stay valid.
    version: int = 0
    row_cache: dict[tuple, list[MasterLine]] = field(default_factory=dict)
    # AppState.db_generation this session last read the shared DB at.
    shared_generation: int = -1

    def touch(self) -> None:
        self.last_seen = time.time()

    def changed(self) -> None:
        self.version += 1
        self.row_cache.clear()


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.lock = threading.RLock()
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.sessions_dir.mkdir(parents=True, exist_ok=True)
        if not settings.db_path.exists() and settings.seed_db and settings.seed_db.exists():
            # First start: begin from an existing desktop DB instead of an empty one.
            shutil.copy(settings.seed_db, settings.db_path)
        self.con = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.con.execute("pragma journal_mode=wal")
        ensure_schema(self.con)
        self.sessions: dict[str, SessionState] = {}
        # Bumped after every write to the shared DB, so sessions re-read it only when
        # it changed (re-reading 14,000 deleted rows on every request is slow).
        self.db_generation = 0
        # Leftover upload folders from a previous run belong to sessions that no longer exist.
        for stale in settings.sessions_dir.iterdir():
            shutil.rmtree(stale, ignore_errors=True)

    def bump(self) -> None:
        self.db_generation += 1

    def sync_shared(self, session: SessionState) -> None:
        if session.shared_generation != self.db_generation:
            session.work.reload_shared()
            session.shared_generation = self.db_generation
            session.row_cache.clear()

    def new_session(self) -> SessionState:
        sid = secrets.token_urlsafe(32)
        directory = self.settings.sessions_dir / sid
        directory.mkdir(parents=True, exist_ok=True)
        session = SessionState(sid=sid, work=WorkSession(self.con), directory=directory)
        self.sessions[sid] = session
        return session

    def get_session(self, sid: str) -> SessionState | None:
        self.expire_idle()
        session = self.sessions.get(sid)
        if session is not None:
            session.touch()
        return session

    def drop_session(self, sid: str) -> None:
        session = self.sessions.pop(sid, None)
        if session is not None:
            shutil.rmtree(session.directory, ignore_errors=True)

    def expire_idle(self) -> None:
        limit = time.time() - self.settings.session_ttl_hours * 3600
        for sid in [sid for sid, session in self.sessions.items() if session.last_seen < limit]:
            self.drop_session(sid)

    def close(self) -> None:
        self.con.close()
