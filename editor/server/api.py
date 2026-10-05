"""JSON API. Every handler is a thin adapter over master_reducer: the rules live there.

Handlers run under AppState.lock (see state.py). Row identity: rows of the session's
new master are addressed by line index; rows that come from the shared DB are
addressed by barcode, so another user's change cannot shift what an index means.
"""

from __future__ import annotations

import dataclasses
import re
import secrets
import time
import zipfile
from datetime import date
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from master_reducer.core import (
    BARCODE_BYTES,
    LONG_NAME_BYTES,
    SHORT_NAME_BYTES,
    KEY_BARCODE,
    KEY_FULL_ROW,
    MasterLine,
    compose_fixed_width_row,
    extract_short_name,
    extract_tail_text,
    lines_from_raw,
    replace_short_name,
    write_master_file,
)
from master_reducer.db import (
    CATEGORY_TOBACCO,
    PRODUCT_SOURCES,
    SEARCH_FIELD_BARCODE,
    SEARCH_FIELD_PRODUCT_NAME,
    SOURCE_PAID,
    BundleLayout,
    add_search_preset,
    apply_workbook_target,
    delete_search_presets,
    delete_source_lines,
    fetch_search_presets,
    import_bundle_master,
    import_category_master_excel,
    import_paid_master,
    product_source,
    read_bundle_workbook,
    read_import_candidate_lines,
    read_meta,
    reorder_search_presets,
    save_source_lines,
    source_barcodes,
    workbook_target_counts,
    write_meta,
)
from master_reducer.outputs import (
    BASE_LABELS,
    FILTER_FF,
    FILTER_TOBACCO,
    OUTPUT_SPEC_BY_KEY,
    OUTPUT_SPECS,
    OutputContext,
    OutputPlan,
    OutputSpec,
    compose_output,
    default_filename,
    default_prefix_from_source,
    default_workbook_filename,
    group_label,
    output_raw_lines,
)
from master_reducer.workbook_export import SHEET_BY_OUTPUT, missing_template_sheets, write_integrated_workbook
from master_reducer.workspace import (
    FILE_SLOTS,
    KIND_DB,
    KIND_EDIT,
    MASTER_ROW_TABS,
    SLOT_DELETE,
    SLOT_ROWS,
    SORT_COLUMNS,
    TAB_DEF_BY_KEY,
    TAB_DEFS,
    TAB_DELETED,
    TAB_FF_DELETED,
    TAB_TOBACCO_DELETED,
    ActionResult,
    WorkSession,
)

from .auth import Auth
from .publish import PublishError, publish_master
from .state import AppState, ImportPreview, SessionState, WorkbookPreview

META_TEMPLATE_NAME = "web_integrated_template_name"
ROW_BYTES = BARCODE_BYTES + LONG_NAME_BYTES + SHORT_NAME_BYTES
MAX_PAGE = 2000
_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


# ----------------------------------------------------------------- payloads


class LoginBody(BaseModel):
    password: str = Field(max_length=200)


class Selection(BaseModel):
    """Rows an action applies to: explicit keys, or every row the tab currently shows."""

    tab: str
    keys: list[str] = Field(default_factory=list)
    all_visible: bool = False
    field: str = SEARCH_FIELD_PRODUCT_NAME
    q: str = ""


class CompareBody(BaseModel):
    key_mode: str = KEY_BARCODE


class ProductRowBody(BaseModel):
    barcode: str = Field(max_length=13)
    long_name: str = ""
    short_name: str = ""
    tail: str = ""
    original: str = ""
    overwrite: bool = False


class BarcodesBody(BaseModel):
    barcodes: list[str]


class ImportSaveBody(BaseModel):
    offsets: list[int]


class WorkbookShortNameBody(BaseModel):
    target: str
    index: int
    short_name: str = Field(max_length=40)


class WorkbookApplyBody(BaseModel):
    targets: list[str]


class PresetBody(BaseModel):
    field: str
    keyword: str = Field(max_length=60)


class PresetsBody(BaseModel):
    field: str
    keywords: list[str]


class PlanItem(BaseModel):
    key: str
    enabled: bool = True
    appends: list[str] = Field(default_factory=list)
    filename: str = ""


class PlanBody(BaseModel):
    plans: list[PlanItem]
    prefix: str = ""


class SaveBody(PlanBody):
    workbook: bool = False
    workbook_filename: str = ""
    # Output key to also publish as the KRS Master site's active master ("" = don't).
    publish: str = ""


# ------------------------------------------------------------------ helpers


def result_json(result: ActionResult) -> dict:
    return {"ok": result.ok, "message": result.message, "count": result.count, "details": result.details}


def safe_filename(name: str, fallback: str) -> str:
    cleaned = _UNSAFE_FILENAME.sub("_", Path(name or "").name).strip(" .")
    return cleaned or fallback


def line_json(line: MasterLine, tab_key: str, session: WorkSession, append_set: set[str] | None) -> dict:
    tab = TAB_DEF_BY_KEY[tab_key]
    by_index = tab_key in MASTER_ROW_TABS or tab_key == TAB_DELETED
    row = {
        "key": str(line.index) if by_index else line.barcode,
        "no": line.index + 1,
        "barcode": line.barcode,
        "long_name": line.long_name,
        "short_name": line.short_name,
        "text": line.display_text,
        "malformed": len(line.raw_line) < ROW_BYTES,
    }
    if tab.kind == KIND_EDIT:
        row["checked"] = line.index in session.checked_new_indexes
    if tab.kind == KIND_DB:
        row["append"] = "-" if append_set is None else ("예" if line.barcode in append_set else "")
    return row


def summary_line(context: OutputContext, spec: OutputSpec, rows) -> str:
    """Same text as the desktop save dialog's '저장될 행수' box."""

    def available(group_key: str) -> int:
        for key, lines in context.restore_groups(spec):
            if key == group_key:
                return len(lines)
        return len(context.append_lines_by_source.get(group_key, []))

    parts = [f"기본 {len(rows.kept):,}"]
    skipped = 0
    keyword_skipped = 0
    for group_key, added in rows.append_counts.items():
        offered = available(group_key)
        skipped += offered - added
        keyword_skipped += context.restore_keyword_excluded_count(spec, group_key)
        if added or offered:
            parts.append(f"{group_label(group_key)} {added:,}")
    notes = []
    if keyword_skipped:
        notes.append(f"밀박스 제외 {keyword_skipped:,}행")
    if skipped:
        notes.append(f"중복 {skipped:,}행 제외")
    suffix = f"   ({', '.join(notes)})" if notes else ""
    return f"{' + '.join(parts)}{suffix}"


def build_router(state: AppState, auth: Auth) -> APIRouter:
    router = APIRouter(prefix="/api")
    settings = state.settings

    def guarded(request: Request, action: Callable[[SessionState], object]):
        with state.lock:
            session = auth.session_for(request)
            return action(session)

    async def save_upload(session: SessionState, upload: UploadFile, prefix: str) -> tuple[Path, str]:
        """Stream an upload into the session folder, refusing anything over the size limit."""
        original = safe_filename(upload.filename or "", "upload")
        suffix = Path(original).suffix.lower()[:8]
        target = session.directory / f"{prefix}_{secrets.token_hex(6)}{suffix}"
        size = 0
        with target.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    handle.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(413, f"파일이 너무 큽니다(최대 {settings.max_upload_mb}MB).")
                handle.write(chunk)
        return target, original

    def session_only(request: Request) -> SessionState:
        with state.lock:
            return auth.session_for(request)

    # ------------------------------------------------------------- auth

    @router.post("/login")
    def login(body: LoginBody, request: Request, response: Response):
        with state.lock:
            auth.login(request, response, body.password)
        return {"ok": True}

    @router.get("/me")
    def me(request: Request):
        """Is this browser logged in? The KRS Master site uses it to unlock admin features.

        Deliberately does not take AppState.lock: the site calls this while checking an
        upload, and must not wait behind a long editor operation (e.g. a 100k-row save).
        """
        if not auth.is_logged_in(request):
            raise HTTPException(401, "로그인이 필요합니다.")
        return {"ok": True, "admin": True}

    @router.post("/logout")
    def logout(request: Request, response: Response):
        with state.lock:
            auth.logout(request, response)
        return {"ok": True}

    # ------------------------------------------------------------ state

    def state_json(session: SessionState, field: str = "", q: str = "") -> dict:
        work = session.work
        state.sync_shared(session)
        slots = {}
        for row in SLOT_ROWS:
            for slot, label in row:
                slots[slot] = {
                    "label": label,
                    "name": work.file_names.get(slot, ""),
                    "rows": work.slot_line_count(slot) if slot in FILE_SLOTS else 0,
                }
        counts = {tab.key: len(work.visible_lines(tab.key, field, q)) for tab in TAB_DEFS}
        return {
            "slot_rows": [[slot for slot, _label in row] for row in SLOT_ROWS],
            "slots": slots,
            "tabs": [dataclasses.asdict(tab) for tab in TAB_DEFS],
            "counts": counts,
            "excluded": len(work.excluded_new_indexes),
            "checked": len(work.checked_new_indexes),
            "key_mode": work.key_mode,
            "compared": work.compare_result is not None,
            "presets": {
                f: fetch_search_presets(work.con, f) for f in (SEARCH_FIELD_PRODUCT_NAME, SEARCH_FIELD_BARCODE)
            },
            "sources": {key: source.label for key, source in PRODUCT_SOURCES.items()},
            "limits": {"barcode": BARCODE_BYTES, "long_name": LONG_NAME_BYTES, "short_name": SHORT_NAME_BYTES},
            "max_upload_mb": settings.max_upload_mb,
        }

    @router.get("/state")
    def get_state(request: Request, field: str = "", q: str = ""):
        return guarded(request, lambda s: state_json(s, field, q))

    # ------------------------------------------------------------ files

    @router.post("/files/{slot}")
    async def upload_slot(slot: str, request: Request, file: UploadFile = File(...)):
        if slot not in (*FILE_SLOTS, SLOT_DELETE):
            raise HTTPException(404, "알 수 없는 파일 칸입니다.")
        session = await run_in_threadpool(session_only, request)
        path, original = await save_upload(session, file, slot)

        def action(s: SessionState):
            try:
                result = s.work.load_slot(slot, path, original)
            except (OSError, ValueError) as exc:
                raise HTTPException(400, f"파일을 읽을 수 없습니다: {exc}") from exc
            finally:
                if slot == SLOT_DELETE:
                    path.unlink(missing_ok=True)
            state.bump()
            s.changed()
            return result_json(result)

        return await run_in_threadpool(guarded, request, action)

    # ------------------------------------------------------------- rows

    def visible(session: SessionState, tab: str, field: str, q: str, sort: str, reverse: bool) -> list[MasterLine]:
        if tab not in TAB_DEF_BY_KEY:
            raise HTTPException(404, "알 수 없는 탭입니다.")
        if sort not in SORT_COLUMNS:
            sort = "barcode"
        cache_key = (tab, field, q, sort, reverse)
        cacheable = tab in MASTER_ROW_TABS or tab == TAB_DELETED
        if cacheable and cache_key in session.row_cache:
            return session.row_cache[cache_key]
        lines = session.work.sort_lines(session.work.visible_lines(tab, field, q), sort, reverse)
        if cacheable:
            session.row_cache[cache_key] = lines
        return lines

    @router.get("/rows/{tab}")
    def get_rows(
        tab: str,
        request: Request,
        offset: int = 0,
        limit: int = 200,
        sort: str = "barcode",
        reverse: bool = False,
        field: str = "",
        q: str = "",
    ):
        def action(s: SessionState):
            state.sync_shared(s)
            lines = visible(s, tab, field, q, sort, reverse)
            page = lines[max(0, offset) : max(0, offset) + min(max(1, limit), MAX_PAGE)]
            append_set = s.work.append_barcodes() if TAB_DEF_BY_KEY[tab].kind == KIND_DB else None
            return {"total": len(lines), "offset": offset, "rows": [line_json(l, tab, s.work, append_set) for l in page]}

        return guarded(request, action)

    def resolve(session: SessionState, sel: Selection) -> tuple[set[int], set[str]]:
        """Selection -> (line indexes, barcodes)."""
        if sel.tab not in TAB_DEF_BY_KEY:
            raise HTTPException(404, "알 수 없는 탭입니다.")
        if sel.all_visible:
            lines = session.work.visible_lines(sel.tab, sel.field, sel.q)
            return {line.index for line in lines}, {line.barcode for line in lines}
        indexes: set[int] = set()
        barcodes: set[str] = set()
        for key in sel.keys:
            if sel.tab in MASTER_ROW_TABS or sel.tab == TAB_DELETED:
                try:
                    indexes.add(int(key))
                except ValueError:
                    continue
            else:
                barcodes.add(key)
        return indexes, barcodes

    def mutate(request: Request, action: Callable[[SessionState], ActionResult]):
        def run(s: SessionState):
            state.sync_shared(s)
            result = action(s)
            state.bump()
            s.changed()
            return result_json(result)

        return guarded(request, run)

    @router.post("/compare")
    def compare(body: CompareBody, request: Request):
        if body.key_mode not in (KEY_BARCODE, KEY_FULL_ROW):
            raise HTTPException(400, "비교 기준이 올바르지 않습니다.")
        return mutate(request, lambda s: s.work.run_compare(body.key_mode))

    @router.post("/rows/check")
    def toggle_check(sel: Selection, request: Request):
        def action(s: SessionState):
            if sel.tab not in ("all", "added"):
                return ActionResult("전체 행 또는 추가 행 탭에서만 체크할 수 있습니다.", ok=False)
            indexes, _ = resolve(s, sel)
            return s.work.toggle_checked(indexes)

        return mutate(request, action)

    @router.post("/reduce/delete")
    def delete_rows(sel: Selection, request: Request):
        def action(s: SessionState):
            if sel.tab not in ("all", "added"):
                return ActionResult("전체 행 또는 추가 행 탭에서 삭제할 행을 선택하세요.", ok=False)
            indexes, _ = resolve(s, sel)
            return s.work.delete_rows(indexes)

        return mutate(request, action)

    @router.post("/reduce/delete-checked")
    def delete_checked(request: Request):
        return mutate(request, lambda s: s.work.delete_checked_rows())

    @router.post("/reduce/apply-saved")
    def apply_saved(request: Request):
        return mutate(request, lambda s: s.work.apply_saved_deletions())

    @router.post("/reduce/delete-tobacco")
    def delete_tobacco(request: Request):
        return mutate(request, lambda s: s.work.delete_matching_category_rows(CATEGORY_TOBACCO))

    @router.post("/reduce/delete-ff")
    def delete_ff(request: Request):
        return mutate(request, lambda s: s.work.delete_matching_ff_rows())

    @router.post("/reduce/restore")
    def restore(sel: Selection, request: Request):
        def action(s: SessionState):
            indexes, barcodes = resolve(s, sel)
            if sel.tab == TAB_TOBACCO_DELETED:
                return s.work.restore_category_selected(CATEGORY_TOBACCO, barcodes)
            return s.work.restore_selected(sel.tab, indexes, barcodes)

        return mutate(request, action)

    @router.post("/reduce/restore-tobacco")
    def restore_tobacco(sel: Selection, request: Request):
        def action(s: SessionState):
            if sel.tab != TAB_TOBACCO_DELETED:
                return ActionResult("삭제된 담배행 탭에서 복구할 행을 선택하세요.", ok=False)
            _, barcodes = resolve(s, sel)
            return s.work.restore_category_selected(CATEGORY_TOBACCO, barcodes)

        return mutate(request, action)

    @router.post("/reduce/restore-ff")
    def restore_ff(sel: Selection, request: Request):
        def action(s: SessionState):
            if sel.tab != TAB_FF_DELETED:
                return ActionResult("삭제된 FF행 탭에서 복구할 행을 선택하세요.", ok=False)
            indexes, barcodes = resolve(s, sel)
            return s.work.restore_selected(TAB_FF_DELETED, indexes, barcodes)

        return mutate(request, action)

    # --------------------------------------------------------- products

    def require_source(source_key: str) -> None:
        if source_key not in PRODUCT_SOURCES:
            raise HTTPException(404, "알 수 없는 상품 DB입니다.")

    @router.get("/products/{source_key}/row/{barcode}")
    def get_product_row(source_key: str, barcode: str, request: Request):
        require_source(source_key)

        def action(s: SessionState):
            s.work.reload_product_rows()
            for line in s.work.product_rows[source_key]:
                if line.barcode == barcode:
                    return {
                        "barcode": line.barcode,
                        "long_name": line.long_name,
                        "short_name": line.short_name,
                        "tail": extract_tail_text(line.raw_line),
                    }
            raise HTTPException(404, "행을 찾을 수 없습니다.")

        return guarded(request, action)

    @router.post("/products/{source_key}/row")
    def save_product_row(source_key: str, body: ProductRowBody, request: Request):
        require_source(source_key)

        def action(s: SessionState):
            try:
                raw_line = compose_fixed_width_row(body.barcode, body.long_name, body.short_name, body.tail)
            except UnicodeEncodeError as exc:
                raise HTTPException(400, "현재 입력값을 CP949로 저장할 수 없습니다.") from exc
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            line = lines_from_raw([raw_line])[0]
            if not line.barcode:
                raise HTTPException(400, "바코드는 비워둘 수 없습니다.")
            source = product_source(source_key)
            existing = source_barcodes(s.work.con, source_key)
            if line.barcode != body.original and line.barcode in existing and not body.overwrite:
                return {"ok": False, "duplicate": True,
                        "message": f"{source.label} DB에 이미 {line.barcode}가 있습니다. 기존 행을 덮어쓸까요?"}
            save_source_lines(s.work.con, source_key, [raw_line])
            if body.original and body.original != line.barcode:
                delete_source_lines(s.work.con, source_key, [body.original])
            s.work.reload_product_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"{source.label} DB 저장: {line.barcode} {line.long_name}"}

        return guarded(request, action)

    @router.post("/products/{source_key}/delete")
    def delete_product_rows(source_key: str, body: BarcodesBody, request: Request):
        require_source(source_key)

        def action(s: SessionState):
            count = delete_source_lines(s.work.con, source_key, body.barcodes)
            s.work.reload_product_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"{product_source(source_key).label} DB 삭제: {count:,}행"}

        return guarded(request, action)

    @router.post("/products/{source_key}/import-preview")
    async def import_preview(source_key: str, request: Request, file: UploadFile = File(...)):
        require_source(source_key)
        session = await run_in_threadpool(session_only, request)
        path, original = await save_upload(session, file, "import")

        def action(s: SessionState):
            try:
                raw_lines = read_import_candidate_lines(path)
            except Exception as exc:  # noqa: BLE001 - any parse failure is reported to the user
                raise HTTPException(400, f"불러오기 오류: {exc}") from exc
            finally:
                path.unlink(missing_ok=True)
            if not raw_lines:
                raise HTTPException(400, "추가할 수 있는 행을 찾지 못했습니다.")
            lines = lines_from_raw(raw_lines)
            existing = source_barcodes(s.work.con, source_key)
            s.import_preview = ImportPreview(source_key, original, lines, existing)
            return {
                "file_name": original,
                "source_label": product_source(source_key).label,
                "duplicates": sum(1 for line in lines if line.barcode in existing),
                "rows": [
                    {
                        "offset": offset,
                        "state": "중복" if line.barcode in existing else "신규",
                        "barcode": line.barcode,
                        "long_name": line.long_name,
                        "short_name": line.short_name,
                    }
                    for offset, line in enumerate(lines)
                ],
            }

        return await run_in_threadpool(guarded, request, action)

    @router.post("/products/{source_key}/import-save")
    def import_save(source_key: str, body: ImportSaveBody, request: Request):
        require_source(source_key)

        def action(s: SessionState):
            preview = s.import_preview
            if preview is None or preview.source_key != source_key:
                raise HTTPException(409, "불러오기 미리보기가 없습니다. 파일을 다시 선택하세요.")
            chosen = sorted({o for o in body.offsets if 0 <= o < len(preview.lines)})
            if not chosen:
                return {"ok": False, "message": "저장할 행을 하나 이상 선택하세요."}
            count = save_source_lines(s.work.con, source_key, [preview.lines[o].raw_line for o in chosen])
            s.import_preview = None
            s.work.reload_product_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"{product_source(source_key).label} DB 불러오기 완료: {count:,}행 저장"}

        return guarded(request, action)

    @router.post("/products/paid/replace")
    async def replace_paid(request: Request, file: UploadFile = File(...)):
        session = await run_in_threadpool(session_only, request)
        path, _original = await save_upload(session, file, "paid")

        def action(s: SessionState):
            try:
                count = import_paid_master(s.work.con, path)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(400, f"DB 가져오기 오류: {exc}") from exc
            finally:
                path.unlink(missing_ok=True)
            s.work.reload_product_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"종량제 DB 전체 교체 완료: {count:,}행"}

        return await run_in_threadpool(guarded, request, action)

    @router.post("/products/bundle/import-text")
    async def import_bundle_text(
        request: Request,
        file: UploadFile = File(...),
        bundle_barcode_start: int = Form(1),
        bundle_barcode_length: int = Form(13),
        bundle_name_start: int = Form(14),
        bundle_name_length: int = Form(40),
        quantity_start: int = Form(54),
        quantity_length: int = Form(4),
        unit_barcode_start: int = Form(58),
        unit_barcode_length: int = Form(13),
        unit_name_start: int = Form(71),
        unit_name_length: int = Form(40),
    ):
        values = dict(
            bundle_barcode_start=bundle_barcode_start, bundle_barcode_length=bundle_barcode_length,
            bundle_name_start=bundle_name_start, bundle_name_length=bundle_name_length,
            quantity_start=quantity_start, quantity_length=quantity_length,
            unit_barcode_start=unit_barcode_start, unit_barcode_length=unit_barcode_length,
            unit_name_start=unit_name_start, unit_name_length=unit_name_length,
        )
        if any(value <= 0 for value in values.values()):
            raise HTTPException(400, "모든 컬럼 위치와 길이는 1 이상이어야 합니다.")
        session = await run_in_threadpool(session_only, request)
        path, _original = await save_upload(session, file, "bundle")

        def action(s: SessionState):
            try:
                count = import_bundle_master(s.work.con, path, BundleLayout(**values))
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(400, f"DB 가져오기 오류: {exc}") from exc
            finally:
                path.unlink(missing_ok=True)
            s.work.reload_product_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"번들 DB 저장 완료: {count:,}행"}

        return await run_in_threadpool(guarded, request, action)

    @router.post("/products/tobacco/import-excel")
    async def import_tobacco_excel(request: Request, file: UploadFile = File(...)):
        session = await run_in_threadpool(session_only, request)
        path, _original = await save_upload(session, file, "tobacco")

        def action(s: SessionState):
            try:
                count = import_category_master_excel(s.work.con, path, CATEGORY_TOBACCO)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(400, f"엑셀 가져오기 오류: {exc}") from exc
            finally:
                path.unlink(missing_ok=True)
            s.work.reload_category_rows()
            state.bump()
            s.changed()
            return {"ok": True, "message": f"담배+담배보루 엑셀 저장 완료: {count:,}행"}

        return await run_in_threadpool(guarded, request, action)

    # ---------------------------------------------------- workbook import

    def workbook_row_json(target, index: int, row) -> dict:
        extra = ""
        if row.quantity or row.unit_barcode:
            extra = f"{row.quantity or '-'}입 / {row.unit_barcode} {row.unit_name}".strip()
        return {
            "target": target.key,
            "index": index,
            "group": target.label,
            "barcode": row.barcode,
            "long_name": row.name,
            "short_name": extract_short_name(row.raw_line),
            "extra": extra,
            "note": row.note,
        }

    @router.post("/workbook/preview")
    async def workbook_preview(request: Request, file: UploadFile = File(...)):
        session = await run_in_threadpool(session_only, request)
        path, original = await save_upload(session, file, "workbook")

        def action(s: SessionState):
            try:
                targets = read_bundle_workbook(path)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(400, f"통합 엑셀 오류: {exc}") from exc
            finally:
                path.unlink(missing_ok=True)
            if not targets:
                raise HTTPException(
                    400,
                    "가져올 수 있는 시트를 찾지 못했습니다. '번들' 시트는 '번들바코드', '번들상품명', '중분류' 머리글이 "
                    "필요하고, '종량제' 시트는 A열에 완성된 고정폭 행이 있어야 합니다.",
                )
            counts = {target.key: workbook_target_counts(s.work.con, target) for target in targets}
            s.workbook_preview = WorkbookPreview(original, targets, counts)
            return {
                "file_name": original,
                "targets": [
                    {
                        "key": target.key,
                        "label": target.label,
                        "source_label": target.source_label,
                        "current": counts.get(target.key, 0),
                        "new": len(target.rows),
                        "note_count": target.note_count,
                        # 경고가 있는 행을 먼저 보여 준다(데스크톱 미리보기와 같은 순서).
                        "rows": [
                            workbook_row_json(target, index, row)
                            for index, row in sorted(enumerate(target.rows), key=lambda item: not item[1].note)
                        ],
                    }
                    for target in targets
                ],
            }

        return await run_in_threadpool(guarded, request, action)

    @router.post("/workbook/short-name")
    def workbook_short_name(body: WorkbookShortNameBody, request: Request):
        def action(s: SessionState):
            preview = s.workbook_preview
            if preview is None:
                raise HTTPException(409, "통합 엑셀 미리보기가 없습니다.")
            target = next((t for t in preview.targets if t.key == body.target), None)
            if target is None or not 0 <= body.index < len(target.rows):
                raise HTTPException(404, "행을 찾을 수 없습니다.")
            value = body.short_name.strip()
            if not value:
                raise HTTPException(400, "상품명(단축)은 비워둘 수 없습니다.")
            original = target.rows[body.index]
            updated = dataclasses.replace(original, raw_line=replace_short_name(original.raw_line, value))
            target.rows[body.index] = updated
            return workbook_row_json(target, body.index, updated)

        return guarded(request, action)

    @router.post("/workbook/apply")
    def workbook_apply(body: WorkbookApplyBody, request: Request):
        def action(s: SessionState):
            preview = s.workbook_preview
            if preview is None:
                raise HTTPException(409, "통합 엑셀 미리보기가 없습니다. 파일을 다시 선택하세요.")
            selected = [t for t in preview.targets if t.key in set(body.targets)]
            if not selected:
                return {"ok": False, "message": "교체할 DB를 하나 이상 선택하세요."}
            saved = []
            for target in selected:
                count = apply_workbook_target(s.work.con, target)
                saved.append(f"{target.label} {preview.current_counts.get(target.key, 0):,} → {count:,}행")
            s.workbook_preview = None
            s.work.reload_shared()
            state.bump()
            s.changed()
            return {"ok": True, "message": "통합 엑셀 교체: " + " · ".join(saved), "lines": saved}

        return guarded(request, action)

    # ------------------------------------------------------------ presets

    @router.post("/presets/add")
    def preset_add(body: PresetBody, request: Request):
        def action(s: SessionState):
            if add_search_preset(s.work.con, body.field, body.keyword):
                return {"ok": True, "message": f"빠른 검색어 추가: {body.field} '{body.keyword.strip()}'"}
            return {"ok": False, "message": f"이미 등록된 검색어입니다: '{body.keyword.strip()}'"}

        return guarded(request, action)

    @router.post("/presets/delete")
    def preset_delete(body: PresetsBody, request: Request):
        def action(s: SessionState):
            count = delete_search_presets(s.work.con, body.field, body.keywords)
            return {"ok": True, "message": f"빠른 검색어 삭제: {count}개"}

        return guarded(request, action)

    @router.post("/presets/reorder")
    def preset_reorder(body: PresetsBody, request: Request):
        def action(s: SessionState):
            reorder_search_presets(s.work.con, body.field, body.keywords)
            return {"ok": True}

        return guarded(request, action)

    # ------------------------------------------------------------- outputs

    @router.get("/outputs/panel")
    def output_panel(request: Request):
        def action(s: SessionState):
            state.sync_shared(s)
            context = s.work.build_fresh_output_context()
            items = []
            for spec in OUTPUT_SPECS:
                available = context.is_available(spec)
                total = None
                if available:
                    plan = OutputPlan(spec=spec, path=Path(spec.key), append_sources=spec.default_appends)
                    total = compose_output(context, plan).total
                added = [
                    f"{group_label(key)} {len(lines):,}행" for key, lines in context.restore_groups(spec) if lines
                ]
                added.extend(group_label(key) for key in spec.default_appends)
                items.append({
                    "key": spec.key,
                    "label": spec.label,
                    "base": f"{BASE_LABELS[spec.base]} ({len(context.base_lines(spec)):,}행)",
                    "exclude": {FILTER_FF: "FF 상품", FILTER_TOBACCO: "담배 상품"}.get(spec.exclude_filter or "", "없음"),
                    "appends": ", ".join(added) if added else "없음",
                    "rows": total,
                    "state": spec.description if available else context.unavailable_reason(spec),
                })
            return {"outputs": items}

        return guarded(request, action)

    def default_prefix(work: WorkSession) -> str:
        return default_prefix_from_source(work.source_stem()) or f"MASTER_{date.today():%Y%m%d}"

    @router.get("/outputs/options")
    def output_options(request: Request):
        def action(s: SessionState):
            state.sync_shared(s)
            context = s.work.build_fresh_output_context()
            template_name = read_meta(s.work.con, META_TEMPLATE_NAME) if settings.template_path.exists() else None
            prefix = default_prefix(s.work)
            return {
                "prefix": prefix,
                "workbook_filename": default_workbook_filename(prefix),
                "template": template_name,
                "publish_enabled": settings.publish_enabled,
                "sheet_pairs": [[OUTPUT_SPEC_BY_KEY[k].label, sheet] for k, sheet in SHEET_BY_OUTPUT.items()],
                "sources": [[key, source.label] for key, source in PRODUCT_SOURCES.items()],
                "outputs": [
                    {
                        "key": spec.key,
                        "label": spec.label,
                        "available": context.is_available(spec),
                        "note": spec.description if context.is_available(spec) else context.unavailable_reason(spec),
                        "default_appends": list(spec.default_appends),
                        "fixed_filename": spec.fixed_filename,
                    }
                    for spec in OUTPUT_SPECS
                ],
            }

        return guarded(request, action)

    def compose_plans(context: OutputContext, body: PlanBody):
        composed = []
        for item in body.plans:
            spec = OUTPUT_SPEC_BY_KEY.get(item.key)
            if spec is None or not item.enabled or not context.is_available(spec):
                continue
            appends = tuple(key for key in PRODUCT_SOURCES if key in set(item.appends))
            plan = OutputPlan(spec=spec, path=Path(spec.key), append_sources=appends)
            composed.append((item, spec, compose_output(context, plan)))
        return composed

    @router.post("/outputs/plan")
    def output_plan(body: PlanBody, request: Request):
        """Live row counts for the save dialog (desktop: recount on every checkbox click)."""

        def action(s: SessionState):
            state.sync_shared(s)
            context = s.work.build_fresh_output_context()
            return {
                "outputs": [
                    {
                        "key": spec.key,
                        "total": rows.total,
                        "filename": default_filename(spec, body.prefix, rows.total),
                        "summary": summary_line(context, spec, rows),
                    }
                    for _item, spec, rows in compose_plans(context, body)
                ]
            }

        return guarded(request, action)

    @router.post("/outputs/template")
    async def upload_template(request: Request, file: UploadFile = File(...)):
        session = await run_in_threadpool(session_only, request)
        path, original = await save_upload(session, file, "template")

        def action(s: SessionState):
            try:
                missing = missing_template_sheets(path)
            except Exception as exc:  # noqa: BLE001
                path.unlink(missing_ok=True)
                raise HTTPException(400, f"템플릿 엑셀을 읽을 수 없습니다: {exc}") from exc
            if missing:
                path.unlink(missing_ok=True)
                raise HTTPException(400, "템플릿 엑셀에 krs_gs25 필수 시트가 없습니다: " + ", ".join(missing))
            # 공유 템플릿: 마지막으로 올린 파일을 모두가 쓴다(데스크톱의 '마지막 템플릿 기억'에 해당).
            path.replace(settings.template_path)
            write_meta(s.work.con, META_TEMPLATE_NAME, original)
            return {"ok": True, "template": original}

        return await run_in_threadpool(guarded, request, action)

    @router.post("/outputs/save")
    def output_save(body: SaveBody, request: Request):
        def action(s: SessionState):
            state.sync_shared(s)
            context = s.work.build_fresh_output_context()
            composed = compose_plans(context, body)
            if not composed:
                return {"ok": False, "message": "저장할 출력을 하나 이상 선택하세요."}
            names = []
            for item, spec, rows in composed:
                name = safe_filename(item.filename, default_filename(spec, body.prefix, rows.total))
                if not name.lower().endswith(".txt"):
                    name += ".txt"
                names.append(name)
            if len(set(names)) != len(names):
                return {"ok": False, "message": "출력 파일명이 서로 중복됩니다."}

            out_dir = s.directory / f"out_{int(time.time())}_{secrets.token_hex(4)}"
            out_dir.mkdir()
            summaries = []
            for (item, spec, rows), name in zip(composed, names):
                write_master_file(out_dir / name, rows.kept, context.newline, rows.appended)
                summaries.append(f"{spec.label}: {rows.total:,}행 = {summary_line(context, spec, rows)}  → {name}")

            if body.workbook:
                if not settings.template_path.exists():
                    return {"ok": False, "message": "통합 엑셀 템플릿을 먼저 올려 주세요."}
                sheet_lines = {
                    SHEET_BY_OUTPUT[spec.key]: output_raw_lines(rows)
                    for _item, spec, rows in composed
                    if spec.key in SHEET_BY_OUTPUT
                }
                if not sheet_lines:
                    labels = ", ".join(OUTPUT_SPEC_BY_KEY[k].label for k in SHEET_BY_OUTPUT)
                    return {"ok": False, "message": f"통합 엑셀에 들어갈 출력({labels}) 중 하나 이상을 선택하세요."}
                workbook_name = safe_filename(body.workbook_filename, default_workbook_filename(body.prefix))
                if not workbook_name.lower().endswith(".xlsx"):
                    workbook_name += ".xlsx"
                exported = write_integrated_workbook(settings.template_path, out_dir / workbook_name, sheet_lines)
                kept = [sheet for sheet in SHEET_BY_OUTPUT.values() if sheet not in sheet_lines]
                counts = " / ".join(f"{name} {count:,}행" for name, count in exported.row_counts.items())
                line = f"통합 엑셀: {counts}"
                if kept:
                    line += f", {'·'.join(kept)} 시트는 템플릿 그대로"
                summaries.append(f"{line}  → {workbook_name}")
                for sheet, count in exported.padded_counts.items():
                    summaries.append(f"  · {sheet}: 57byte 미만 행 {count:,}개를 고정폭으로 맞춤")
                for sheet, count in exported.dropped_counts.items():
                    summaries.append(f"  · {sheet}: 상품명 없는 행 {count:,}개 제외 (krs_gs25가 읽을 수 없음)")

            published = None
            if body.publish:
                target = next(
                    ((spec, name) for (_item, spec, _rows), name in zip(composed, names) if spec.key == body.publish),
                    None,
                )
                if target is None:
                    return {"ok": False, "message": "게시할 출력이 저장 대상에 없습니다. 그 출력을 함께 저장하세요."}
                spec, name = target
                try:
                    site = publish_master(settings, name, (out_dir / name).read_bytes())
                    count = site.get("recordCount")
                    published = {"ok": True, "label": spec.label, "file_name": site.get("fileName", name), "count": count}
                    summaries.append(
                        f"사이트 현재 마스터 게시: {spec.label} → {site.get('fileName', name)}"
                        + (f" ({count:,}건)" if isinstance(count, int) else "")
                    )
                except PublishError as exc:
                    # 파일 저장은 그대로 두고 게시 실패만 알린다.
                    published = {"ok": False, "label": spec.label, "error": str(exc)}
                    summaries.append(f"사이트 게시 실패: {exc}")

            zip_name = f"{safe_filename(body.prefix, 'MASTER') or 'MASTER'}_출력.zip"
            zip_path = s.directory / f"{out_dir.name}.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path in sorted(out_dir.iterdir()):
                    archive.write(path, path.name)
            for path in out_dir.iterdir():
                path.unlink()
            out_dir.rmdir()
            token = secrets.token_urlsafe(16)
            s.downloads = {token: zip_path}  # 이전 다운로드는 하나만 유지
            return {
                "ok": True,
                "summary": summaries,
                "download": f"api/outputs/download/{token}",
                "zip_name": zip_name,
                "published": published,
            }

        return guarded(request, action)

    @router.get("/outputs/download/{token}")
    def output_download(token: str, request: Request):
        def action(s: SessionState):
            path = s.downloads.get(token)
            if path is None or not path.exists():
                raise HTTPException(404, "다운로드할 파일이 없습니다. 다시 저장하세요.")
            return path

        path = guarded(request, action)
        prefix = request.query_params.get("name", "출력.zip")
        return FileResponse(path, media_type="application/zip", filename=safe_filename(prefix, "출력.zip"))

    return router
