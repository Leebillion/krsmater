"""UI-free work session: the state and reduction operations of one user.

The desktop app (app.py) keeps this state on its Tk window. The web app needs the
same behaviour without Tk, so the operations are ported here method by method with
identical rules; they return an ActionResult (message + counts) instead of showing
message boxes. Shared product data always comes from the SQLite DB, while the loaded
master files and the excluded/checked rows belong to the session only.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .core import (
    KEY_BARCODE,
    CompareResult,
    MasterFile,
    MasterLine,
    compare_master_files,
    indexes_for_barcodes,
    lines_from_raw,
    non_duplicate_appends,
    prepend_raw_lines,
    read_master_file,
    remove_lines_by_index,
)
from .db import (
    CATEGORY_FF,
    CATEGORY_TOBACCO,
    PRODUCT_SOURCES,
    SEARCH_FIELD_BARCODE,
    SOURCE_PAID,
    delete_category_deleted_lines,
    delete_deleted_lines,
    fetch_category_deleted_lines,
    fetch_category_master_lines,
    fetch_deleted_lines,
    fetch_source_lines,
    import_deleted_template_lines,
    save_category_deleted_lines,
    save_deleted_lines,
)
from .outputs import RESTORE_FF, RESTORE_TOBACCO, OutputContext
from .rules import is_ff_candidate_line

SLOT_OLD = "old"
SLOT_NEW = "new"
SLOT_DELETE = "delete"
SLOT_SHORT = "short"
SLOT_FULL = "full"
SLOT_CLOSED = "closed"
# 상단 파일 바 순서(1줄: 감축 작업용, 2줄: 출력에 바로 쓰는 원본).
SLOT_ROWS = (
    ((SLOT_OLD, "기존 마스터"), (SLOT_NEW, "신규 마스터"), (SLOT_DELETE, "삭제 마스터")),
    ((SLOT_SHORT, "단축 마스터"), (SLOT_FULL, "전체 마스터"), (SLOT_CLOSED, "폐점 마스터")),
)
FILE_SLOTS = (SLOT_OLD, SLOT_NEW, SLOT_SHORT, SLOT_FULL, SLOT_CLOSED)

GROUP_COMPARE = "compare"
GROUP_REDUCE = "reduce"
GROUP_PRODUCT = "product"
GROUP_OUTPUT = "output"

KIND_EDIT = "edit"
KIND_VIEW = "view"
KIND_DB = "db"
KIND_CATALOG = "catalog"

CATEGORY_LABELS = {CATEGORY_TOBACCO: "담배+담배보루"}
DELETED_CATEGORY_LABELS = {CATEGORY_TOBACCO: "삭제된 담배행", CATEGORY_FF: "삭제된 FF행"}

TAB_ALL = "all"
TAB_ADDED = "added"
TAB_DELETED = "deleted"
TAB_EXCLUDED = "excluded"
TAB_DELETED_TEMPLATE = "deleted_template"
TAB_TOBACCO_DELETED = f"{CATEGORY_TOBACCO}_deleted"
TAB_FF_DELETED = f"{CATEGORY_FF}_deleted"
TAB_TOBACCO = CATEGORY_TOBACCO

# Rows of these tabs are lines of the session's new master, addressed by line index.
MASTER_ROW_TABS = (TAB_ALL, TAB_ADDED, TAB_EXCLUDED)
# Rows of these tabs come from the shared DB and are addressed by barcode.
RESTORE_TABS = (TAB_EXCLUDED, TAB_DELETED_TEMPLATE, TAB_FF_DELETED)

SORT_COLUMNS = ("index", "barcode", "long_name", "short_name")


@dataclass(frozen=True)
class TabDef:
    key: str
    label: str
    group: str
    kind: str
    show_excluded: bool = True


TAB_DEFS: tuple[TabDef, ...] = (
    TabDef(TAB_ALL, "전체 행", GROUP_COMPARE, KIND_EDIT, show_excluded=False),
    TabDef(TAB_ADDED, "추가 행", GROUP_COMPARE, KIND_EDIT, show_excluded=False),
    TabDef(TAB_DELETED, "삭제 행(조회)", GROUP_COMPARE, KIND_VIEW),
    TabDef(TAB_EXCLUDED, "현재 삭제 행", GROUP_REDUCE, KIND_VIEW),
    TabDef(TAB_DELETED_TEMPLATE, "삭제한 행", GROUP_REDUCE, KIND_VIEW),
    TabDef(TAB_TOBACCO_DELETED, DELETED_CATEGORY_LABELS[CATEGORY_TOBACCO], GROUP_REDUCE, KIND_VIEW),
    TabDef(TAB_FF_DELETED, DELETED_CATEGORY_LABELS[CATEGORY_FF], GROUP_REDUCE, KIND_VIEW),
    *(
        TabDef(key, f"{source.label} DB", GROUP_PRODUCT, KIND_DB)
        for key, source in PRODUCT_SOURCES.items()
    ),
    TabDef(TAB_TOBACCO, CATEGORY_LABELS[CATEGORY_TOBACCO], GROUP_PRODUCT, KIND_CATALOG),
)
TAB_DEF_BY_KEY = {tab.key: tab for tab in TAB_DEFS}


@dataclass
class ActionResult:
    """What an operation did, for the caller to show (desktop: status bar)."""

    message: str
    count: int = 0
    ok: bool = True
    details: dict[str, int] = field(default_factory=dict)


class WorkSession:
    def __init__(self, con: sqlite3.Connection) -> None:
        self.con = con
        self.files: dict[str, MasterFile | None] = {slot: None for slot in FILE_SLOTS}
        self.file_names: dict[str, str] = {}
        self.compare_result: CompareResult | None = None
        self.key_mode = KEY_BARCODE
        self.excluded_new_indexes: set[int] = set()
        self.checked_new_indexes: set[int] = set()
        self.product_rows: dict[str, list[MasterLine]] = {key: [] for key in PRODUCT_SOURCES}
        self.deleted_templates: list[MasterLine] = []
        self.category_master_rows: dict[str, list[MasterLine]] = {CATEGORY_TOBACCO: []}
        self.category_deleted_rows: dict[str, list[MasterLine]] = {CATEGORY_TOBACCO: []}
        self.reload_shared()

    # ------------------------------------------------------------ shared DB

    def reload_shared(self) -> None:
        """Re-read everything that lives in the shared DB (other users may have changed it)."""
        self.reload_product_rows()
        self.reload_deleted_templates()
        self.reload_category_rows()

    def reload_product_rows(self) -> None:
        for source_key in PRODUCT_SOURCES:
            self.product_rows[source_key] = lines_from_raw(fetch_source_lines(self.con, source_key))

    def reload_deleted_templates(self) -> None:
        self.deleted_templates = lines_from_raw(fetch_deleted_lines(self.con))

    def reload_category_rows(self) -> None:
        self.category_master_rows[CATEGORY_TOBACCO] = lines_from_raw(
            fetch_category_master_lines(self.con, CATEGORY_TOBACCO)
        )
        self.category_deleted_rows[CATEGORY_TOBACCO] = lines_from_raw(
            fetch_category_deleted_lines(self.con, CATEGORY_TOBACCO)
        )

    # ---------------------------------------------------------------- files

    @property
    def old_file(self) -> MasterFile | None:
        return self.files[SLOT_OLD]

    @property
    def new_file(self) -> MasterFile | None:
        return self.files[SLOT_NEW]

    @new_file.setter
    def new_file(self, value: MasterFile | None) -> None:
        self.files[SLOT_NEW] = value

    def load_slot(self, slot: str, path: str | Path, display_name: str = "") -> ActionResult:
        """Load an uploaded file into a slot (desktop: the '…' buttons of the file bar)."""
        name = display_name or Path(path).name
        if slot == SLOT_DELETE:
            master = read_master_file(path)
            added, skipped, invalid = import_deleted_template_lines(
                self.con, [line.raw_line for line in master.lines]
            )
            self.reload_deleted_templates()
            self.file_names[slot] = name
            message = f"삭제 마스터 불러오기: 추가 {added:,}행, 중복 스킵 {skipped:,}행"
            if invalid:
                message += f", 바코드 없음 스킵 {invalid:,}행"
            message += f" (삭제한 행 합계 {len(self.deleted_templates):,}행)"
            return ActionResult(message, added, details={"added": added, "skipped": skipped, "invalid": invalid})
        if slot not in FILE_SLOTS:
            raise ValueError(f"알 수 없는 파일 칸입니다: {slot}")
        master = read_master_file(path)
        self.files[slot] = master
        self.file_names[slot] = name
        if slot == SLOT_NEW:
            self.compare_result = None
            self.excluded_new_indexes.clear()
            self.checked_new_indexes.clear()
        labels = {
            SLOT_OLD: "기존 마스터",
            SLOT_NEW: "신규 마스터",
            SLOT_SHORT: "단축 마스터 (PDA Short 기준)",
            SLOT_FULL: "전체 마스터 (PDA Full · Full 마스터 기준)",
            SLOT_CLOSED: "폐점 마스터 (폐점 마스터 출력 기준)",
        }
        return ActionResult(f"{labels[slot]} 로딩: {len(master.lines):,}행", len(master.lines))

    def slot_line_count(self, slot: str) -> int:
        master = self.files.get(slot)
        return len(master.lines) if master is not None else 0

    # -------------------------------------------------------------- compare

    def run_compare(self, key_mode: str | None = None) -> ActionResult:
        if self.old_file is None or self.new_file is None:
            return ActionResult("기존 마스터와 신규 마스터 파일을 모두 선택하세요.", ok=False)
        if key_mode:
            self.key_mode = key_mode
        self.compare_result = compare_master_files(self.old_file, self.new_file, self.key_mode)
        self.excluded_new_indexes.clear()
        self.checked_new_indexes.clear()
        return ActionResult(
            f"비교 완료: 전체 {len(self.new_file.lines):,}행, 추가 {len(self.compare_result.added):,}행, "
            f"삭제 {len(self.compare_result.deleted):,}행",
            len(self.compare_result.added),
        )

    def refresh_compare_result_if_needed(self) -> None:
        if self.old_file is None or self.new_file is None or self.compare_result is None:
            return
        self.compare_result = compare_master_files(self.old_file, self.new_file, self.key_mode)

    # ---------------------------------------------------------- tab contents

    def lines_all(self) -> list[MasterLine]:
        return self.new_file.lines if self.new_file else []

    def lines_added(self) -> list[MasterLine]:
        return self.compare_result.added if self.compare_result else []

    def lines_deleted(self) -> list[MasterLine]:
        return self.compare_result.deleted if self.compare_result else []

    def lines_excluded(self) -> list[MasterLine]:
        if self.new_file is None:
            return []
        return [line for line in self.new_file.lines if line.index in self.excluded_new_indexes]

    def lines_ff_deleted(self) -> list[MasterLine]:
        """삭제된 FF행 = 삭제한 행 중 FF 조건을 만족하는 상품 (조회 탭, 팀원용/PDA FF 복구 대상)."""
        return [line for line in self.deleted_templates if is_ff_candidate_line(line)]

    def lines_ff_in_master(self) -> list[MasterLine]:
        """현재 신규 마스터에서 FF 조건에 맞는 모든 행 (팀장용 FF 자동 최종 제외 기준)."""
        if self.new_file is None:
            return []
        return [line for line in self.new_file.lines if is_ff_candidate_line(line)]

    def category_lines(self, category: str) -> list[MasterLine]:
        return self.category_master_rows[category]

    def tab_lines(self, tab_key: str) -> list[MasterLine]:
        providers = {
            TAB_ALL: self.lines_all,
            TAB_ADDED: self.lines_added,
            TAB_DELETED: self.lines_deleted,
            TAB_EXCLUDED: self.lines_excluded,
            TAB_DELETED_TEMPLATE: lambda: self.deleted_templates,
            TAB_TOBACCO_DELETED: lambda: self.category_deleted_rows[CATEGORY_TOBACCO],
            TAB_FF_DELETED: self.lines_ff_deleted,
            TAB_TOBACCO: lambda: self.category_lines(CATEGORY_TOBACCO),
        }
        if tab_key in PRODUCT_SOURCES:
            return self.product_rows[tab_key]
        if tab_key not in providers:
            raise KeyError(tab_key)
        return providers[tab_key]()

    def visible_lines(
        self, tab_key: str, search_field: str = "", search_text: str = ""
    ) -> list[MasterLine]:
        tab = TAB_DEF_BY_KEY[tab_key]
        query = search_text.strip().casefold()

        def matches(line: MasterLine) -> bool:
            if not query:
                return True
            if search_field == SEARCH_FIELD_BARCODE:
                return query in line.barcode.casefold()
            return query in line.long_name.casefold() or query in line.short_name.casefold()

        lines = self.tab_lines(tab_key)
        if tab.show_excluded:
            return [line for line in lines if matches(line)]
        return [line for line in lines if line.index not in self.excluded_new_indexes and matches(line)]

    @staticmethod
    def sort_lines(lines: list[MasterLine], column: str = "barcode", reverse: bool = False) -> list[MasterLine]:
        def key(line: MasterLine) -> tuple[str | int, int]:
            if column == "index":
                return line.index, line.index
            if column == "long_name":
                return line.long_name.casefold(), line.index
            if column == "short_name":
                return line.short_name.casefold(), line.index
            return line.barcode, line.index

        return sorted(lines, key=key, reverse=reverse)

    def append_barcodes(self) -> set[str] | None:
        """상품 DB 탭의 '추가예정' 표시: 감축본에 없어 종량제로 실제 붙을 바코드."""
        if self.new_file is None:
            return None
        remaining = remove_lines_by_index(self.new_file.lines, self.excluded_new_indexes)
        candidates = [line.raw_line for line in self.product_rows[SOURCE_PAID]]
        picked = non_duplicate_appends(remaining, candidates)
        return {line.barcode for line in lines_from_raw(picked)}

    def master_lines_by_index(self, indexes: set[int]) -> list[MasterLine]:
        if self.new_file is None:
            return []
        return [line for line in self.new_file.lines if line.index in indexes]

    def tab_lines_by_barcode(self, tab_key: str, barcodes: set[str]) -> list[MasterLine]:
        return [line for line in self.tab_lines(tab_key) if line.barcode in barcodes]

    # ------------------------------------------------------------- reduction

    def toggle_checked(self, indexes: set[int]) -> ActionResult:
        for index in indexes:
            if index in self.checked_new_indexes:
                self.checked_new_indexes.discard(index)
            else:
                self.checked_new_indexes.add(index)
        return ActionResult(f"체크 {len(self.checked_new_indexes):,}행", len(indexes))

    def mark_lines_deleted(self, lines: list[MasterLine], status_prefix: str) -> ActionResult:
        if not lines:
            return ActionResult(f"{status_prefix}: 대상 행이 없습니다.", ok=False)
        for line in lines:
            self.excluded_new_indexes.add(line.index)
            self.checked_new_indexes.discard(line.index)
        raw_lines = [line.raw_line for line in lines]
        if raw_lines:
            save_deleted_lines(self.con, raw_lines)
            self.reload_deleted_templates()
        return ActionResult(
            f"{status_prefix}: {len(lines):,}행 반영, 삭제한 행 {len(self.deleted_templates):,}개", len(lines)
        )

    def delete_rows(self, indexes: set[int]) -> ActionResult:
        """선택 행 삭제 (전체 행 / 추가 행 탭)."""
        return self.mark_lines_deleted(self.master_lines_by_index(indexes), "선택 행 삭제")

    def delete_checked_rows(self) -> ActionResult:
        if not self.checked_new_indexes:
            return ActionResult("체크된 행이 없습니다.", ok=False)
        if self.new_file is None:
            return ActionResult("신규 마스터가 없습니다.", ok=False)
        return self.mark_lines_deleted(self.master_lines_by_index(set(self.checked_new_indexes)), "체크 행 삭제")

    def _reinsert(self, lines: list[MasterLine], restore_barcodes: set[str]) -> tuple[int, int]:
        """Re-include restored barcodes in the new master, inserting only those missing.

        먼저 현재 마스터에 이미 있는 바코드인지 전부 검사한 뒤에만 끼워 넣는다 -- 이미 있는
        행은 다시 삽입하지 않고 제외 표시만 풀어, 같은 바코드가 두 번 생기지 않게 한다.
        """
        inserted_count = 0
        duplicate_count = 0
        if self.new_file is not None and restore_barcodes:
            existing = {line.barcode for line in self.new_file.lines}
            missing = [line.raw_line for line in lines if line.barcode and line.barcode not in existing]
            duplicate_count = len(restore_barcodes) - len(missing)
            if missing:
                self.new_file = prepend_raw_lines(self.new_file, missing)
                inserted_count = len(missing)
            for line in self.new_file.lines:
                if line.barcode in restore_barcodes:
                    self.excluded_new_indexes.discard(line.index)
                    self.checked_new_indexes.discard(line.index)
        self.refresh_compare_result_if_needed()
        return inserted_count, duplicate_count

    @staticmethod
    def _restore_suffix(inserted_count: int, duplicate_count: int) -> str:
        detail = [f"신규 삽입 {inserted_count:,}행"] if inserted_count else []
        if duplicate_count:
            detail.append(f"이미 마스터에 있어 건너뜀 {duplicate_count:,}행")
        return f", {', '.join(detail)}" if detail else ""

    def restore_lines(self, lines: list[MasterLine], status_prefix: str) -> ActionResult:
        if not lines:
            return ActionResult(f"{status_prefix}: 복구할 행을 선택하세요.", ok=False)
        restore_barcodes = {line.barcode for line in lines if line.barcode}
        delete_deleted_lines(self.con, list(restore_barcodes))
        self.reload_deleted_templates()
        inserted_count, duplicate_count = self._reinsert(lines, restore_barcodes)
        return ActionResult(
            f"{status_prefix}: {len(lines):,}행 복구{self._restore_suffix(inserted_count, duplicate_count)}, "
            f"삭제한 행 {len(self.deleted_templates):,}개",
            len(lines),
            details={"inserted": inserted_count, "duplicate": duplicate_count},
        )

    def restore_selected(self, tab_key: str, indexes: set[int], barcodes: set[str]) -> ActionResult:
        """선택 행 복구 (현재 삭제 행 / 삭제한 행 / 삭제된 FF행 탭)."""
        if tab_key == TAB_EXCLUDED:
            lines = [line for line in self.lines_excluded() if line.index in indexes]
        elif tab_key in (TAB_DELETED_TEMPLATE, TAB_FF_DELETED):
            lines = self.tab_lines_by_barcode(tab_key, barcodes)
        else:
            return ActionResult("현재 삭제 행 또는 삭제한 행 탭에서 복구할 행을 선택하세요.", ok=False)
        prefix = "FF 복구" if tab_key == TAB_FF_DELETED else "선택 행 복구"
        return self.restore_lines(lines, prefix)

    def apply_saved_deletions(self) -> ActionResult:
        if self.new_file is None:
            return ActionResult("신규 마스터 파일을 먼저 선택하세요.", ok=False)
        if not self.deleted_templates:
            return ActionResult("삭제한 행 탭에 저장된 기준이 없습니다.", ok=False)
        matched = indexes_for_barcodes(self.new_file.lines, [line.barcode for line in self.deleted_templates])
        new_indexes = matched - self.excluded_new_indexes
        if not new_indexes:
            return ActionResult("기존 삭제 기준과 일치하는 신규 행이 없습니다.", ok=False)
        return self.mark_lines_deleted(self.master_lines_by_index(new_indexes), "기존 삭제 실행")

    def delete_matching_category_rows(self, category: str = CATEGORY_TOBACCO) -> ActionResult:
        if self.new_file is None:
            return ActionResult("신규 마스터 파일을 먼저 선택하세요.", ok=False)
        barcodes = {line.barcode for line in self.category_lines(category) if line.barcode}
        if not barcodes:
            return ActionResult(f"{CATEGORY_LABELS[category]} 목록이 비어 있습니다.", ok=False)
        matched = [
            line
            for line in self.new_file.lines
            if line.barcode in barcodes and line.index not in self.excluded_new_indexes
        ]
        if not matched:
            return ActionResult(f"{CATEGORY_LABELS[category]} 바코드와 일치하는 신규 행이 없습니다.", ok=False)
        for line in matched:
            self.excluded_new_indexes.add(line.index)
            self.checked_new_indexes.discard(line.index)
        save_category_deleted_lines(self.con, category, [line.raw_line for line in matched])
        self.reload_category_rows()
        return ActionResult(
            f"{CATEGORY_LABELS[category]} 삭제: {len(matched):,}행 반영, 저장 제외 {len(self.excluded_new_indexes):,}행",
            len(matched),
        )

    def delete_matching_ff_rows(self) -> ActionResult:
        """FF 일괄 삭제: 감축본 용량을 줄이는 수동 조작 (팀장용 FF 자동 제외와 별개)."""
        if self.new_file is None:
            return ActionResult("신규 마스터 파일을 먼저 선택하세요.", ok=False)
        matched = [line for line in self.lines_ff_in_master() if line.index not in self.excluded_new_indexes]
        if not matched:
            return ActionResult("FF 조건과 일치하는 신규 행이 없습니다.", ok=False)
        return self.mark_lines_deleted(matched, "FF 일괄 삭제")

    def restore_category_selected(self, category: str, barcodes: set[str]) -> ActionResult:
        selected = [line for line in self.category_deleted_rows[category] if line.barcode in barcodes]
        if not selected:
            return ActionResult(f"{DELETED_CATEGORY_LABELS[category]} 탭에서 복구할 행을 선택하세요.", ok=False)
        restore_barcodes = {line.barcode for line in selected if line.barcode}
        delete_category_deleted_lines(self.con, category, list(restore_barcodes))
        self.reload_category_rows()
        inserted_count, duplicate_count = self._reinsert(selected, restore_barcodes)
        return ActionResult(
            f"{CATEGORY_LABELS[category]} 복구: {len(selected):,}행 복구"
            f"{self._restore_suffix(inserted_count, duplicate_count)}",
            len(selected),
            details={"inserted": inserted_count, "duplicate": duplicate_count},
        )

    # ---------------------------------------------------------------- output

    def build_output_context(self) -> OutputContext:
        reduced = (
            remove_lines_by_index(self.new_file.lines, self.excluded_new_indexes) if self.new_file is not None else []
        )
        short_file = self.files[SLOT_SHORT]
        full_file = self.files[SLOT_FULL]
        closed_file = self.files[SLOT_CLOSED]
        loaded = [f for f in (self.new_file, short_file, full_file, closed_file) if f is not None]
        return OutputContext(
            reduced_lines=reduced,
            newline=loaded[0].newline if loaded else b"\r\n",
            short_master_lines=short_file.lines if short_file else [],
            full_master_lines=full_file.lines if full_file else [],
            closed_master_lines=closed_file.lines if closed_file else [],
            tobacco_barcodes={line.barcode for line in self.category_lines(CATEGORY_TOBACCO) if line.barcode},
            ff_barcodes={line.barcode for line in self.lines_ff_in_master() if line.barcode},
            append_lines_by_source={
                key: [line.raw_line for line in self.product_rows[key]] for key in PRODUCT_SOURCES
            },
            restore_lines_by_group={
                RESTORE_TOBACCO: [line.raw_line for line in self.category_deleted_rows[CATEGORY_TOBACCO]],
                RESTORE_FF: [line.raw_line for line in self.lines_ff_deleted()],
            },
        )

    def build_fresh_output_context(self) -> OutputContext:
        """build_output_context(), but re-reading the shared DB first (same rule as the desktop app)."""
        self.reload_product_rows()
        self.reload_category_rows()
        return self.build_output_context()

    def source_stem(self) -> str:
        for slot in (SLOT_NEW, SLOT_SHORT, SLOT_FULL, SLOT_CLOSED):
            name = self.file_names.get(slot)
            if name and self.files.get(slot) is not None:
                return Path(name).stem
        return ""
