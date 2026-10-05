from __future__ import annotations

import io
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from openpyxl import load_workbook

from .core import (
    BARCODE_BYTES,
    ENCODING,
    LONG_NAME_BYTES,
    SHORT_NAME_BYTES,
    compose_fixed_width_row,
    decode_text,
    extract_barcode,
    measure_text_bytes,
    normalize_raw_line_to_cp949,
    split_line_ending,
    tail_text_to_bytes,
    truncate_text_to_bytes,
)


DB_NAME = "master_management.db"
CATEGORY_TOBACCO = "tobacco"
CATEGORY_FF = "ff"
BARCODE_RE = re.compile(r"\d{13}")

SOURCE_PAID = "paid"
SOURCE_BUNDLE = "bundle"
SOURCE_SHORT = "short"
SOURCE_SERVICE = "service"

SEARCH_FIELD_PRODUCT_NAME = "상품명"
SEARCH_FIELD_BARCODE = "바코드"
DEFAULT_PRODUCT_PRESETS = ("주문", "경쟁사", "해외", "예약", "주인있음", "장터", "경품", "울", "1편", "2편")
DEFAULT_BARCODE_PRESETS = ("28001",)


@dataclass(frozen=True)
class ProductSource:
    key: str
    label: str
    table: str
    key_column: str
    name_column: str


PRODUCT_SOURCES: dict[str, ProductSource] = {
    SOURCE_PAID: ProductSource(SOURCE_PAID, "종량제", "paid_master", "barcode", "long_name"),
    SOURCE_BUNDLE: ProductSource(SOURCE_BUNDLE, "번들", "bundle_master", "bundle_barcode", "bundle_name"),
    SOURCE_SHORT: ProductSource(SOURCE_SHORT, "단축상품", "short_master", "barcode", "long_name"),
    SOURCE_SERVICE: ProductSource(SOURCE_SERVICE, "서비스", "service_master", "barcode", "long_name"),
}


def product_source(source_key: str) -> ProductSource:
    try:
        return PRODUCT_SOURCES[source_key]
    except KeyError:
        raise ValueError(f"알 수 없는 상품 DB 종류입니다: {source_key}") from None


@dataclass(frozen=True)
class BundleLayout:
    bundle_barcode_start: int
    bundle_barcode_length: int
    bundle_name_start: int
    bundle_name_length: int
    quantity_start: int
    quantity_length: int
    unit_barcode_start: int
    unit_barcode_length: int
    unit_name_start: int
    unit_name_length: int


def db_path_for_app(base_dir: str | Path) -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / DB_NAME
    return Path(base_dir) / DB_NAME


def connect_db(path: str | Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.execute("pragma journal_mode=wal")
    ensure_schema(con)
    return con


def ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        create table if not exists paid_master (
            barcode text primary key,
            long_name text,
            raw_line blob not null
        )
        """
    )
    con.execute(
        """
        create table if not exists bundle_master (
            bundle_barcode text primary key,
            bundle_name text,
            quantity integer,
            unit_barcode text,
            unit_name text,
            raw_line blob not null
        )
        """
    )
    con.execute(
        """
        create table if not exists short_master (
            barcode text primary key,
            long_name text,
            raw_line blob not null
        )
        """
    )
    con.execute(
        """
        create table if not exists service_master (
            barcode text primary key,
            long_name text,
            raw_line blob not null
        )
        """
    )
    con.execute(
        """
        create table if not exists deleted_template (
            barcode text primary key,
            long_name text,
            raw_line blob not null
        )
        """
    )
    con.execute(
        """
        create table if not exists category_master (
            category text not null,
            barcode text not null,
            long_name text,
            raw_line blob not null,
            primary key (category, barcode)
        )
        """
    )
    con.execute(
        """
        create table if not exists category_deleted_row (
            category text not null,
            barcode text not null,
            long_name text,
            raw_line blob not null,
            primary key (category, barcode)
        )
        """
    )
    con.execute(
        """
        create table if not exists search_preset (
            field text not null,
            keyword text not null,
            sort_order integer not null default 0,
            primary key (field, keyword)
        )
        """
    )
    con.execute(
        """
        create table if not exists app_meta (
            key text primary key,
            value text
        )
        """
    )
    con.commit()
    seed_search_presets(con)


def read_meta(con: sqlite3.Connection, key: str) -> str | None:
    row = con.execute("select value from app_meta where key = ?", (key,)).fetchone()
    return None if row is None else str(row[0])


def write_meta(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute(
        """
        insert into app_meta (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value
        """,
        (key, value),
    )
    con.commit()


def seed_search_presets(con: sqlite3.Connection) -> int:
    """Insert the built-in quick-search keywords once, so user deletions stay deleted."""
    if read_meta(con, "search_preset_seeded") == "1":
        return 0
    rows = [
        (SEARCH_FIELD_PRODUCT_NAME, keyword, order)
        for order, keyword in enumerate(DEFAULT_PRODUCT_PRESETS)
    ]
    rows.extend(
        (SEARCH_FIELD_BARCODE, keyword, order)
        for order, keyword in enumerate(DEFAULT_BARCODE_PRESETS)
    )
    con.executemany(
        """
        insert into search_preset (field, keyword, sort_order) values (?, ?, ?)
        on conflict(field, keyword) do nothing
        """,
        rows,
    )
    con.commit()
    write_meta(con, "search_preset_seeded", "1")
    return len(rows)


def fetch_search_presets(con: sqlite3.Connection, field: str) -> list[str]:
    rows = con.execute(
        "select keyword from search_preset where field = ? order by sort_order, keyword",
        (field,),
    ).fetchall()
    return [str(row[0]) for row in rows]


def add_search_preset(con: sqlite3.Connection, field: str, keyword: str) -> bool:
    value = keyword.strip()
    if not value:
        return False
    row = con.execute(
        "select coalesce(max(sort_order), -1) + 1 from search_preset where field = ?",
        (field,),
    ).fetchone()
    cur = con.execute(
        """
        insert into search_preset (field, keyword, sort_order) values (?, ?, ?)
        on conflict(field, keyword) do nothing
        """,
        (field, value, int(row[0])),
    )
    con.commit()
    return cur.rowcount > 0


def delete_search_presets(con: sqlite3.Connection, field: str, keywords: list[str]) -> int:
    normalized = sorted({keyword.strip() for keyword in keywords if keyword.strip()})
    if not normalized:
        return 0
    placeholders = ", ".join("?" for _ in normalized)
    cur = con.execute(
        f"delete from search_preset where field = ? and keyword in ({placeholders})",
        [field, *normalized],
    )
    con.commit()
    return int(cur.rowcount)


def reorder_search_presets(con: sqlite3.Connection, field: str, keywords: list[str]) -> None:
    con.executemany(
        "update search_preset set sort_order = ? where field = ? and keyword = ?",
        [(order, field, keyword) for order, keyword in enumerate(keywords)],
    )
    con.commit()


def iter_body_lines(path: str | Path) -> list[bytes]:
    content = Path(path).read_bytes()
    lines: list[bytes] = []
    for raw in content.splitlines(keepends=True):
        body, _ending = split_line_ending(raw)
        if body:
            lines.append(body)
    return lines


def normalize_barcode_value(value: object) -> str:
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, float):
        if not value.is_integer():
            return ""
        text = str(int(value))
    else:
        text = str(value).strip()
    digits = "".join(ch for ch in text if ch.isdigit())
    return digits if len(digits) == 13 else ""


def normalize_name_value(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if BARCODE_RE.fullmatch(text):
        return ""
    if text.replace(" ", "").isdigit():
        return ""
    return text


def choose_row_name(barcodes: list[tuple[int, str]], texts: list[tuple[int, str]]) -> str:
    if not texts:
        return ""
    first_barcode_col = barcodes[0][0]
    left_candidates = [item for item in texts if item[0] < first_barcode_col]
    if left_candidates:
        return left_candidates[-1][1]
    right_candidates = [item for item in texts if item[0] > first_barcode_col]
    if right_candidates:
        return right_candidates[0][1]
    return texts[0][1]


def iter_excel_category_rows(path: str | Path) -> list[tuple[str, str, bytes]]:
    # Read into memory first so the .xlsx is not left locked on Windows.
    workbook = load_workbook(filename=io.BytesIO(Path(path).read_bytes()), read_only=True, data_only=True)
    rows_by_barcode: dict[str, tuple[str, str, bytes]] = {}
    try:
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows(values_only=True):
                barcodes: list[tuple[int, str]] = []
                texts: list[tuple[int, str]] = []
                for col_index, value in enumerate(row):
                    barcode = normalize_barcode_value(value)
                    if barcode:
                        barcodes.append((col_index, barcode))
                        continue
                    text = normalize_name_value(value)
                    if text:
                        texts.append((col_index, text))
                if not barcodes:
                    continue
                name = choose_row_name(barcodes, texts)
                for _col_index, barcode in barcodes:
                    rows_by_barcode[barcode] = (barcode, name, compose_fixed_width_row(barcode, name, ""))
    finally:
        workbook.close()
    return list(rows_by_barcode.values())


def import_paid_master(con: sqlite3.Connection, path: str | Path) -> int:
    rows = []
    seen: set[str] = set()
    for raw_line in iter_body_lines(path):
        normalized = normalize_raw_line_to_cp949(raw_line)
        barcode = extract_barcode(normalized)
        if not barcode or barcode in seen:
            continue
        seen.add(barcode)
        long_name = decode_text(normalized[13:])
        rows.append((barcode, long_name, normalized))
    con.execute("delete from paid_master")
    if rows:
        con.executemany(
            """
            insert into paid_master (barcode, long_name, raw_line)
            values (?, ?, ?)
            """,
            rows,
        )
    con.commit()
    return len(rows)


def slice_bytes(raw: bytes, start: int, length: int) -> bytes:
    if start <= 0 or length <= 0:
        return b""
    zero_based = start - 1
    return raw[zero_based : zero_based + length]


def parse_int(raw: bytes) -> int | None:
    text = raw.decode(ENCODING, errors="ignore").strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        digits = "".join(ch for ch in text if ch.isdigit())
        return int(digits) if digits else None


def import_bundle_master(con: sqlite3.Connection, path: str | Path, layout: BundleLayout) -> int:
    rows = []
    for raw_line in iter_body_lines(path):
        bundle_barcode = slice_bytes(
            raw_line, layout.bundle_barcode_start, layout.bundle_barcode_length
        ).decode("ascii", errors="ignore").strip()
        if not bundle_barcode:
            continue
        bundle_name = decode_text(slice_bytes(raw_line, layout.bundle_name_start, layout.bundle_name_length))
        quantity = parse_int(slice_bytes(raw_line, layout.quantity_start, layout.quantity_length))
        unit_barcode = slice_bytes(raw_line, layout.unit_barcode_start, layout.unit_barcode_length).decode(
            "ascii", errors="ignore"
        ).strip()
        unit_name = decode_text(slice_bytes(raw_line, layout.unit_name_start, layout.unit_name_length))
        rows.append((bundle_barcode, bundle_name, quantity, unit_barcode, unit_name, raw_line))
    con.executemany(
        """
        insert into bundle_master (
            bundle_barcode, bundle_name, quantity, unit_barcode, unit_name, raw_line
        )
        values (?, ?, ?, ?, ?, ?)
        on conflict(bundle_barcode) do update set
            bundle_name = excluded.bundle_name,
            quantity = excluded.quantity,
            unit_barcode = excluded.unit_barcode,
            unit_name = excluded.unit_name,
            raw_line = excluded.raw_line
        """,
        rows,
    )
    con.commit()
    return len(rows)


def save_category_master_lines(con: sqlite3.Connection, category: str, raw_lines: list[bytes]) -> int:
    rows = []
    for raw_line in raw_lines:
        barcode = extract_barcode(raw_line)
        if not barcode:
            continue
        long_name = decode_text(raw_line[13:])
        rows.append((category, barcode, long_name, raw_line))
    if not rows:
        return 0
    con.executemany(
        """
        insert into category_master (category, barcode, long_name, raw_line)
        values (?, ?, ?, ?)
        on conflict(category, barcode) do update set
            long_name = excluded.long_name,
            raw_line = excluded.raw_line
        """,
        rows,
    )
    con.commit()
    return len(rows)


def import_category_master_excel(con: sqlite3.Connection, path: str | Path, category: str) -> int:
    rows = iter_excel_category_rows(path)
    return save_category_master_lines(con, category, [raw_line for _barcode, _name, raw_line in rows])


def fetch_category_master_lines(con: sqlite3.Connection, category: str) -> list[bytes]:
    rows = con.execute(
        "select raw_line from category_master where category = ? order by barcode",
        (category,),
    ).fetchall()
    return [bytes(row[0]) for row in rows]


def save_category_deleted_lines(con: sqlite3.Connection, category: str, raw_lines: list[bytes]) -> int:
    rows = []
    for raw_line in raw_lines:
        barcode = extract_barcode(raw_line)
        if not barcode:
            continue
        long_name = decode_text(raw_line[13:])
        rows.append((category, barcode, long_name, raw_line))
    if not rows:
        return 0
    con.executemany(
        """
        insert into category_deleted_row (category, barcode, long_name, raw_line)
        values (?, ?, ?, ?)
        on conflict(category, barcode) do update set
            long_name = excluded.long_name,
            raw_line = excluded.raw_line
        """,
        rows,
    )
    con.commit()
    return len(rows)


def fetch_category_deleted_lines(con: sqlite3.Connection, category: str) -> list[bytes]:
    rows = con.execute(
        "select raw_line from category_deleted_row where category = ? order by barcode",
        (category,),
    ).fetchall()
    return [bytes(row[0]) for row in rows]


def delete_category_deleted_lines(con: sqlite3.Connection, category: str, barcodes: list[str]) -> int:
    normalized = sorted({barcode.strip() for barcode in barcodes if barcode.strip()})
    if not normalized:
        return 0
    placeholders = ", ".join("?" for _ in normalized)
    params = [category, *normalized]
    cur = con.execute(
        f"delete from category_deleted_row where category = ? and barcode in ({placeholders})",
        params,
    )
    con.commit()
    return int(cur.rowcount)


def fetch_source_lines(con: sqlite3.Connection, source_key: str) -> list[bytes]:
    source = product_source(source_key)
    rows = con.execute(
        f"select raw_line from {source.table} order by {source.key_column}"
    ).fetchall()
    return [bytes(row[0]) for row in rows]


def save_source_lines(con: sqlite3.Connection, source_key: str, raw_lines: list[bytes]) -> int:
    """Upsert master rows into one product DB, normalizing each row to CP949 fixed width."""
    source = product_source(source_key)
    rows = []
    for raw_line in raw_lines:
        normalized = normalize_raw_line_to_cp949(raw_line)
        barcode = extract_barcode(normalized)
        if not barcode:
            continue
        long_name = decode_text(normalized[13:])
        rows.append((barcode, long_name, normalized))
    if not rows:
        return 0
    con.executemany(
        f"""
        insert into {source.table} ({source.key_column}, {source.name_column}, raw_line)
        values (?, ?, ?)
        on conflict({source.key_column}) do update set
            {source.name_column} = excluded.{source.name_column},
            raw_line = excluded.raw_line
        """,
        rows,
    )
    con.commit()
    return len(rows)


def delete_source_lines(con: sqlite3.Connection, source_key: str, barcodes: list[str]) -> int:
    source = product_source(source_key)
    normalized = sorted({barcode.strip() for barcode in barcodes if barcode.strip()})
    if not normalized:
        return 0
    placeholders = ", ".join("?" for _ in normalized)
    cur = con.execute(
        f"delete from {source.table} where {source.key_column} in ({placeholders})",
        normalized,
    )
    con.commit()
    return int(cur.rowcount)


def source_barcodes(con: sqlite3.Connection, source_key: str) -> set[str]:
    source = product_source(source_key)
    rows = con.execute(f"select {source.key_column} from {source.table}").fetchall()
    return {str(row[0]).strip() for row in rows if str(row[0]).strip()}


def fetch_append_lines(con: sqlite3.Connection, source_keys: Iterable[str] = (SOURCE_PAID, SOURCE_BUNDLE)) -> list[bytes]:
    lines: list[bytes] = []
    for source_key in source_keys:
        lines.extend(fetch_source_lines(con, source_key))
    return lines


def fetch_paid_master_lines(con: sqlite3.Connection) -> list[bytes]:
    return fetch_source_lines(con, SOURCE_PAID)


def fetch_bundle_master_lines(con: sqlite3.Connection) -> list[bytes]:
    return fetch_source_lines(con, SOURCE_BUNDLE)


def fetch_short_master_lines(con: sqlite3.Connection) -> list[bytes]:
    return fetch_source_lines(con, SOURCE_SHORT)


def save_paid_master_lines(con: sqlite3.Connection, raw_lines: list[bytes]) -> int:
    return save_source_lines(con, SOURCE_PAID, raw_lines)


def save_deleted_lines(con: sqlite3.Connection, raw_lines: list[bytes]) -> int:
    rows = []
    for raw_line in raw_lines:
        barcode = extract_barcode(raw_line)
        if not barcode:
            continue
        long_name = decode_text(raw_line[13:])
        rows.append((barcode, long_name, raw_line))
    if not rows:
        return 0
    con.executemany(
        """
        insert into deleted_template (barcode, long_name, raw_line)
        values (?, ?, ?)
        on conflict(barcode) do update set
            long_name = excluded.long_name,
            raw_line = excluded.raw_line
        """,
        rows,
    )
    con.commit()
    return len(rows)


def import_deleted_template_lines(con: sqlite3.Connection, raw_lines: list[bytes]) -> tuple[int, int, int]:
    """Import deleted-template rows without overwriting existing barcodes.

    Returns (added, skipped_duplicates, skipped_invalid).
    """
    existing = {str(row[0]) for row in con.execute("select barcode from deleted_template").fetchall()}
    to_insert: list[tuple[str, str, bytes]] = []
    skipped = 0
    invalid = 0
    seen_in_file: set[str] = set()
    for raw_line in raw_lines:
        barcode = extract_barcode(raw_line)
        if not barcode:
            invalid += 1
            continue
        if barcode in existing or barcode in seen_in_file:
            skipped += 1
            continue
        seen_in_file.add(barcode)
        long_name = decode_text(raw_line[13:])
        to_insert.append((barcode, long_name, raw_line))
    if to_insert:
        con.executemany(
            """
            insert into deleted_template (barcode, long_name, raw_line)
            values (?, ?, ?)
            """,
            to_insert,
        )
        con.commit()
    return len(to_insert), skipped, invalid


def fetch_deleted_lines(con: sqlite3.Connection) -> list[bytes]:
    rows = con.execute("select raw_line from deleted_template order by barcode").fetchall()
    return [bytes(row[0]) for row in rows]


def delete_deleted_lines(con: sqlite3.Connection, barcodes: list[str]) -> int:
    normalized = sorted({barcode.strip() for barcode in barcodes if barcode.strip()})
    if not normalized:
        return 0
    placeholders = ", ".join("?" for _ in normalized)
    cur = con.execute(f"delete from deleted_template where barcode in ({placeholders})", normalized)
    con.commit()
    return int(cur.rowcount)


def table_counts(con: sqlite3.Connection) -> tuple[int, int]:
    paid = con.execute("select count(*) from paid_master").fetchone()[0]
    bundle = con.execute("select count(*) from bundle_master").fetchone()[0]
    return int(paid), int(bundle)


# ---------------------------------------------------------------- 통합 엑셀 가져오기

# Excel drops trailing spaces, so the source workbook keeps fixed-width columns aligned
# with visible filler glyphs instead. '…' is two CP949 bytes, '.' is one.
ELLIPSIS_FILLER = "…"
TWO_DOT_FILLER = "‥"
DOT_FILLER = "."

BUNDLE_SHEET_NAME = "번들"
PAID_SHEET_NAME = "종량제"
SERVICE_SHEET_NAME = "서비스"
BUNDLE_HEADER_KEYS = {
    "번들바코드": "bundle_barcode",
    "번들상품명": "bundle_name",
    "입수": "quantity",
    "상품코드": "unit_barcode",
    "상품명": "unit_name",
    "중분류": "category",
}
BUNDLE_CATEGORY_TOBACCO = "담배"
BUNDLE_CATEGORY_GENERAL = "일반"
BUNDLE_CATEGORY_SHORT = "단축"

TARGET_SOURCE = "source"
TARGET_CATEGORY = "category"


@dataclass(frozen=True)
class ImportRow:
    barcode: str
    name: str
    raw_line: bytes
    quantity: int | None = None
    unit_barcode: str = ""
    unit_name: str = ""
    note: str = ""


@dataclass(frozen=True)
class WorkbookTarget:
    """One destination DB that the workbook replaces wholesale."""

    key: str
    label: str
    source_label: str
    target_kind: str
    target_key: str
    rows: list[ImportRow]

    @property
    def note_count(self) -> int:
        return sum(1 for row in self.rows if row.note)


def cell_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


ROW_BYTES = BARCODE_BYTES + LONG_NAME_BYTES + SHORT_NAME_BYTES


def restore_padded_row(text: str) -> bytes | None:
    """Rebuild a fixed-width master row that Excel stored with visible filler glyphs.

    Excel also strips trailing spaces, so rows arrive one or two bytes short; the
    shortfall is always at the end and is padded back out before slicing. Returns
    None when the text is not a fixed-width row at all.
    """
    replaced = text.replace(ELLIPSIS_FILLER, "  ").replace(TWO_DOT_FILLER, " ")
    encoded = replaced.encode(ENCODING, errors="replace")
    if len(encoded) < BARCODE_BYTES or not encoded[:BARCODE_BYTES].strip().isdigit():
        return None
    padded = encoded.ljust(ROW_BYTES, b" ")

    def clean(segment: bytes) -> str:
        # Only a trailing run of dots is padding; '1.5L' inside a name is real.
        return segment.decode(ENCODING, errors="replace").rstrip().rstrip(DOT_FILLER).strip()

    barcode = clean(padded[:BARCODE_BYTES])
    long_name = clean(padded[BARCODE_BYTES : BARCODE_BYTES + LONG_NAME_BYTES])
    short_name = clean(padded[BARCODE_BYTES + LONG_NAME_BYTES : ROW_BYTES])
    tail = padded[ROW_BYTES:].decode(ENCODING, errors="replace").rstrip()
    if not barcode:
        return None
    try:
        return compose_fixed_width_row(barcode, long_name, short_name, tail)
    except (ValueError, UnicodeEncodeError):
        return None


# 번들상품명은 브랜드명 뒤에 세부 옵션이 붙는 형태가 많아, 앞부분만 14byte로 자르면
# 서로 다른 상품이 같은 단축명으로 뭉치기 쉽다(실제 담배 289건 중 19그룹/46건 충돌).
# 앞 4byte(브랜드 힌트)만 남기고 뒤 10byte(대개 옵션·용량 등 차별점)를 붙이면 12그룹/
# 36건으로 줄어든다 -- 사용자가 실측 비교 후 선택한 조합.
BUNDLE_SHORT_NAME_HEAD_BYTES = 4
BUNDLE_SHORT_NAME_TAIL_BYTES = SHORT_NAME_BYTES - BUNDLE_SHORT_NAME_HEAD_BYTES


def build_bundle_short_name(name: str) -> str:
    if measure_text_bytes(name) <= SHORT_NAME_BYTES:
        return name
    head = truncate_text_to_bytes(name, BUNDLE_SHORT_NAME_HEAD_BYTES)
    tail = tail_text_to_bytes(name, BUNDLE_SHORT_NAME_TAIL_BYTES)
    return truncate_text_to_bytes(head + tail, SHORT_NAME_BYTES)


def build_bundle_row(barcode: str, name: str, quantity: int | None, unit_barcode: str, unit_name: str) -> ImportRow:
    """Bundle rows carry no short name, so one is built from the long name (see
    build_bundle_short_name for how collisions between similarly-prefixed names are
    reduced).
    """
    short_name = build_bundle_short_name(name)
    note = ""
    if measure_text_bytes(name) > LONG_NAME_BYTES:
        note = f"상품명 {measure_text_bytes(name)}byte → {LONG_NAME_BYTES}byte로 잘림"
    return ImportRow(
        barcode=barcode,
        name=name,
        raw_line=compose_fixed_width_row(barcode, name, short_name),
        quantity=quantity,
        unit_barcode=unit_barcode,
        unit_name=unit_name,
        note=note,
    )


def read_bundle_sheet(sheet) -> tuple[dict[str, list[ImportRow]], bool]:
    """Read a 번들-shaped sheet into rows grouped by 중분류.

    Also reports whether the sheet looks like a scratch/formula sheet (it carries a
    '복사용' column), so the caller can leave it unchecked by default.
    """
    rows_iter = sheet.iter_rows(values_only=True)
    try:
        header = next(rows_iter)
    except StopIteration:
        return {}, False
    columns = {
        BUNDLE_HEADER_KEYS[cell_text(value)]: index
        for index, value in enumerate(header)
        if cell_text(value) in BUNDLE_HEADER_KEYS
    }
    is_scratch = any("복사" in cell_text(value) for value in header)
    if "bundle_barcode" not in columns or "bundle_name" not in columns:
        return {}, is_scratch

    def get(row: tuple, key: str) -> str:
        index = columns.get(key)
        return "" if index is None or index >= len(row) else cell_text(row[index])

    grouped: dict[str, list[ImportRow]] = {}
    seen: set[str] = set()
    for row in rows_iter:
        barcode = get(row, "bundle_barcode")
        name = get(row, "bundle_name")
        if not barcode or not name or barcode in seen:
            continue
        seen.add(barcode)
        quantity_text = get(row, "quantity")
        try:
            quantity = int(quantity_text) if quantity_text else None
        except ValueError:
            quantity = None
        category = get(row, "category") or "일반"
        grouped.setdefault(category, []).append(
            build_bundle_row(barcode, name, quantity, get(row, "unit_barcode"), get(row, "unit_name"))
        )
    return grouped, is_scratch


def read_paid_sheet(sheet) -> list[ImportRow]:
    """Read a sheet whose first column already holds complete fixed-width rows."""
    rows: list[ImportRow] = []
    seen: set[str] = set()
    for row in sheet.iter_rows(values_only=True):
        text = cell_text(row[0]) if row else ""
        if not text:
            continue
        raw_line = restore_padded_row(text)
        if raw_line is None:
            continue
        barcode = extract_barcode(raw_line)
        if not barcode or barcode in seen:
            continue
        seen.add(barcode)
        rows.append(ImportRow(barcode=barcode, name=decode_text(raw_line[BARCODE_BYTES:]), raw_line=raw_line))
    return rows


def looks_like_paid_sheet(sheet) -> bool:
    """A paid sheet keeps whole fixed-width rows in column A and nothing else."""
    checked = 0
    matched = 0
    for row in sheet.iter_rows(values_only=True):
        text = cell_text(row[0]) if row else ""
        if not text:
            continue
        checked += 1
        wide_enough = measure_text_bytes(text.replace(ELLIPSIS_FILLER, "  ")) >= BARCODE_BYTES + LONG_NAME_BYTES
        if wide_enough and restore_padded_row(text) is not None:
            matched += 1
        if checked >= 20:
            break
    return checked > 0 and matched >= checked * 0.8


def unique_by_barcode(rows: Iterable[ImportRow]) -> list[ImportRow]:
    picked: dict[str, ImportRow] = {}
    for row in rows:
        if row.barcode and row.barcode not in picked:
            picked[row.barcode] = row
    return list(picked.values())


def tobacco_list_rows(bundle_rows: list[ImportRow]) -> list[ImportRow]:
    """담배 보루(번들바코드/번들상품명)와 담배 단품(상품코드/상품명)을 모두 목록에 넣는다."""
    rows: list[ImportRow] = []
    for row in bundle_rows:
        rows.append(ImportRow(barcode=row.barcode, name=row.name, raw_line=row.raw_line, note=row.note))
        if row.unit_barcode:
            unit_name = row.unit_name or row.name
            rows.append(
                ImportRow(
                    barcode=row.unit_barcode,
                    name=unit_name,
                    raw_line=compose_fixed_width_row(
                        row.unit_barcode, unit_name, truncate_text_to_bytes(unit_name, SHORT_NAME_BYTES)
                    ),
                )
            )
    return unique_by_barcode(rows)


def pick_workbook_sheets(workbook) -> tuple[object | None, object | None, object | None]:
    """Find the 번들, 종량제, 서비스 sheets by name, falling back to shape for the first two.

    Scratch sheets that carry a '복사용' column are never used, so the formula
    helper sheet cannot leak rows into the product DBs. 종량제 and 서비스 share the
    same paid-shaped layout, so 서비스 is matched by exact name only -- shape alone
    cannot tell the two apart, and guessing wrong would silently swap their rows.
    """
    bundle_sheet = None
    paid_sheet = None
    service_sheet = None
    for sheet in workbook.worksheets:
        if sheet.title.strip() == BUNDLE_SHEET_NAME:
            bundle_sheet = sheet
        elif sheet.title.strip() == PAID_SHEET_NAME:
            paid_sheet = sheet
        elif sheet.title.strip() == SERVICE_SHEET_NAME:
            service_sheet = sheet
    if bundle_sheet is None or paid_sheet is None:
        for sheet in workbook.worksheets:
            if sheet is bundle_sheet or sheet is paid_sheet or sheet is service_sheet:
                continue
            grouped, is_scratch = read_bundle_sheet(sheet)
            if grouped and not is_scratch and bundle_sheet is None:
                bundle_sheet = sheet
            elif not grouped and paid_sheet is None and looks_like_paid_sheet(sheet):
                paid_sheet = sheet
    return bundle_sheet, paid_sheet, service_sheet


def read_bundle_workbook(path: str | Path) -> list[WorkbookTarget]:
    """Read the combined workbook into the product DBs it replaces.

    | 종량제 DB    | '종량제' 시트                                          |
    | 번들 DB      | '번들' 시트 중분류 담배 + 일반                          |
    | 단축상품 DB   | '번들' 시트 중분류 단축                                |
    | 담배+담배보루 | '번들' 시트 중분류 담배의 번들바코드/상품코드 양쪽        |
    | 서비스 DB    | '서비스' 시트                                          |

    Other sheets (점포코드, 함수저장) are ignored.
    """
    # Load from memory so Windows does not keep the .xlsx locked after the import;
    # a read-only openpyxl workbook otherwise holds the file open.
    workbook = load_workbook(filename=io.BytesIO(Path(path).read_bytes()), read_only=True, data_only=True)
    targets: list[WorkbookTarget] = []
    try:
        bundle_sheet, paid_sheet, service_sheet = pick_workbook_sheets(workbook)

        if paid_sheet is not None:
            paid_rows = read_paid_sheet(paid_sheet)
            if paid_rows:
                targets.append(
                    WorkbookTarget(
                        key=SOURCE_PAID,
                        label=f"{product_source(SOURCE_PAID).label} DB",
                        source_label=f"'{paid_sheet.title}' 시트",
                        target_kind=TARGET_SOURCE,
                        target_key=SOURCE_PAID,
                        rows=paid_rows,
                    )
                )

        if service_sheet is not None:
            service_rows = read_paid_sheet(service_sheet)
            if service_rows:
                targets.append(
                    WorkbookTarget(
                        key=SOURCE_SERVICE,
                        label=f"{product_source(SOURCE_SERVICE).label} DB",
                        source_label=f"'{service_sheet.title}' 시트",
                        target_kind=TARGET_SOURCE,
                        target_key=SOURCE_SERVICE,
                        rows=service_rows,
                    )
                )

        if bundle_sheet is not None:
            grouped, _is_scratch = read_bundle_sheet(bundle_sheet)
            tobacco = grouped.get(BUNDLE_CATEGORY_TOBACCO, [])
            general = grouped.get(BUNDLE_CATEGORY_GENERAL, [])
            short = grouped.get(BUNDLE_CATEGORY_SHORT, [])
            sheet_name = bundle_sheet.title

            bundle_rows = unique_by_barcode([*tobacco, *general])
            if bundle_rows:
                targets.append(
                    WorkbookTarget(
                        key=SOURCE_BUNDLE,
                        label=f"{product_source(SOURCE_BUNDLE).label} DB",
                        source_label=f"'{sheet_name}' 시트 중분류 담배 + 일반",
                        target_kind=TARGET_SOURCE,
                        target_key=SOURCE_BUNDLE,
                        rows=bundle_rows,
                    )
                )
            if short:
                targets.append(
                    WorkbookTarget(
                        key=SOURCE_SHORT,
                        label=f"{product_source(SOURCE_SHORT).label} DB",
                        source_label=f"'{sheet_name}' 시트 중분류 단축",
                        target_kind=TARGET_SOURCE,
                        target_key=SOURCE_SHORT,
                        rows=unique_by_barcode(short),
                    )
                )
            if tobacco:
                targets.append(
                    WorkbookTarget(
                        key=CATEGORY_TOBACCO,
                        label="담배+담배보루 목록",
                        source_label=f"'{sheet_name}' 시트 중분류 담배 (번들바코드 + 상품코드)",
                        target_kind=TARGET_CATEGORY,
                        target_key=CATEGORY_TOBACCO,
                        rows=tobacco_list_rows(tobacco),
                    )
                )
    finally:
        workbook.close()
    return targets


def save_bundle_rows(con: sqlite3.Connection, rows: list[ImportRow]) -> int:
    """Write bundle rows keeping 입수/단품 columns, unlike the generic source writer."""
    payload = [
        (row.barcode, row.name, row.quantity, row.unit_barcode, row.unit_name, row.raw_line)
        for row in rows
        if row.barcode
    ]
    if not payload:
        return 0
    con.executemany(
        """
        insert into bundle_master (
            bundle_barcode, bundle_name, quantity, unit_barcode, unit_name, raw_line
        )
        values (?, ?, ?, ?, ?, ?)
        on conflict(bundle_barcode) do update set
            bundle_name = excluded.bundle_name,
            quantity = excluded.quantity,
            unit_barcode = excluded.unit_barcode,
            unit_name = excluded.unit_name,
            raw_line = excluded.raw_line
        """,
        payload,
    )
    con.commit()
    return len(payload)


def clear_category_master(con: sqlite3.Connection, category: str) -> None:
    con.execute("delete from category_master where category = ?", (category,))


def apply_workbook_target(con: sqlite3.Connection, target: WorkbookTarget) -> int:
    """Replace a destination DB with the workbook's rows.

    The workbook is the source of truth for these four lists, so rows dropped from
    the spreadsheet must disappear here too — this wipes the table before writing.
    """
    if target.target_kind == TARGET_CATEGORY:
        clear_category_master(con, target.target_key)
        return save_category_master_lines(con, target.target_key, [row.raw_line for row in target.rows])
    source = product_source(target.target_key)
    con.execute(f"delete from {source.table}")
    if target.target_key == SOURCE_BUNDLE:
        return save_bundle_rows(con, target.rows)
    return save_source_lines(con, target.target_key, [row.raw_line for row in target.rows])


def workbook_target_counts(con: sqlite3.Connection, target: WorkbookTarget) -> int:
    """Rows the destination holds right now, so the dialog can show 현재 → 신규."""
    if target.target_kind == TARGET_CATEGORY:
        row = con.execute(
            "select count(*) from category_master where category = ?", (target.target_key,)
        ).fetchone()
        return int(row[0])
    source = product_source(target.target_key)
    return int(con.execute(f"select count(*) from {source.table}").fetchone()[0])


def read_import_candidate_lines(path: str | Path) -> list[bytes]:
    """Read rows to add from either a fixed-width master text file or an Excel sheet.

    Both shapes end up as CP949 fixed-width raw lines so the caller can preview them
    with the same MasterLine columns used everywhere else.
    """
    suffix = Path(path).suffix.casefold()
    if suffix in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        return [raw_line for _barcode, _name, raw_line in iter_excel_category_rows(path)]
    lines: list[bytes] = []
    seen: set[str] = set()
    for raw_line in iter_body_lines(path):
        normalized = normalize_raw_line_to_cp949(raw_line)
        barcode = extract_barcode(normalized)
        if not barcode or barcode in seen:
            continue
        seen.add(barcode)
        lines.append(normalized)
    return lines
