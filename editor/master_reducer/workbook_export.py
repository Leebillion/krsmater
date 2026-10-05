"""Write the outputs into a copy of the combined 번들마스터 통합 workbook.

krs_gs25 imports one workbook with nine sheets. This app produces the 팀장, 팀원,
전체 (Full 마스터) and 폐점 sheets from its outputs; 번들, 종량제, 서비스, 점포코드,
함수저장 -- and any of the four whose output was not saved this time -- are copied
from a template workbook the user picks.

The copy is done at the zip level rather than through openpyxl: re-saving with
openpyxl drops the cached values of formula cells (the 번들 sheet has bundle names
like =E346&"(보루)"), and krs_gs25 reads with data_only=True, so those names would
come back empty. Here every part except the two replaced worksheet XMLs is copied
byte for byte.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree
from xml.sax.saxutils import escape

from .core import (
    BARCODE_BYTES,
    ENCODING,
    LONG_NAME_BYTES,
    SHORT_NAME_BYTES,
    extract_long_name,
    extract_short_name,
    normalize_raw_line_to_cp949,
    replace_short_name,
    split_line_ending,
    truncate_text_to_bytes,
)
from .outputs import OUTPUT_CLOSED_MASTER, OUTPUT_FULL_MASTER, OUTPUT_LEADER, OUTPUT_MEMBER

SHEET_LEADER = "팀장"
SHEET_MEMBER = "팀원"
SHEET_ALL = "전체"
SHEET_CLOSED = "폐점"
# Which output fills which sheet. Outputs not saved this time leave the template's sheet.
SHEET_BY_OUTPUT = {
    OUTPUT_LEADER: SHEET_LEADER,
    OUTPUT_MEMBER: SHEET_MEMBER,
    OUTPUT_FULL_MASTER: SHEET_ALL,
    OUTPUT_CLOSED_MASTER: SHEET_CLOSED,
}
# krs_gs25 import_integrated_master_file() refuses a workbook missing any of these.
INTEGRATED_REQUIRED_SHEETS = ("번들", "종량제", "서비스", "점포코드", "함수저장", "전체", "팀장", "팀원", "폐점")

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

ROW_BYTES = BARCODE_BYTES + LONG_NAME_BYTES + SHORT_NAME_BYTES
REPLACEMENT_CHAR = chr(0xFFFD)
# XML 1.0 forbids most control characters (and U+FFFE/U+FFFF). Each control char
# is a single CP949 byte, so swapping it for '?' keeps every fixed-width field in place.
_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f" + chr(0xFFFE) + chr(0xFFFF) + "]")


@dataclass(frozen=True)
class SheetRows:
    """Rows ready for one sheet, plus what had to be adjusted for krs_gs25."""

    rows: list[bytes]
    padded: int = 0
    dropped: int = 0


@dataclass(frozen=True)
class WorkbookExportResult:
    path: Path
    row_counts: dict[str, int]
    padded_counts: dict[str, int]
    dropped_counts: dict[str, int]


def row_cell_text(raw_line: bytes) -> str:
    """One master row as cell text, keeping its byte width when re-encoded as CP949."""
    body, _ending = split_line_ending(raw_line)
    text = body.decode(ENCODING, errors="replace").replace(REPLACEMENT_CHAR, "?")
    return _XML_ILLEGAL.sub("?", text)


def prepare_sheet_rows(raw_lines: Iterable[bytes]) -> SheetRows:
    """Make every row something krs_gs25 can parse, without touching good rows.

    krs_gs25 slices names at fixed byte offsets (long 13~43, short 43~57) and rejects
    the whole workbook if any row yields no name. Hand-appended rows such as
    '8809670763121뉴던힐1MG*10' are shorter than that layout, so rows under 57 bytes
    are rebuilt as fixed-width rows (text after the barcode becomes the long name,
    and its head the short name). Rows carrying no name at all cannot be fixed and
    are dropped. Full-width rows are passed through byte for byte.
    """
    rows: list[bytes] = []
    padded = 0
    dropped = 0
    for raw_line in raw_lines:
        body, _ending = split_line_ending(raw_line)
        if not body.strip():
            continue
        is_short = len(body) < ROW_BYTES
        row = normalize_raw_line_to_cp949(body) if is_short else body
        long_name = extract_long_name(row)
        if not (long_name or extract_short_name(row)):
            dropped += 1
            continue
        if is_short:
            if not extract_short_name(row):
                row = replace_short_name(row, truncate_text_to_bytes(long_name, SHORT_NAME_BYTES))
            padded += 1
        rows.append(row)
    return SheetRows(rows=rows, padded=padded, dropped=dropped)


def build_sheet_xml(raw_lines: Iterable[bytes]) -> bytes:
    """A minimal worksheet holding one row per line in column A as inline strings.

    Inline strings leave the template's sharedStrings.xml untouched, so no other
    sheet's cell indexes shift.
    """
    cells: list[str] = []
    count = 0
    for raw_line in raw_lines:
        text = row_cell_text(raw_line)
        if not text:
            continue
        count += 1
        cells.append(
            f'<row r="{count}"><c r="A{count}" t="inlineStr"><is>'
            f'<t xml:space="preserve">{escape(text)}</t></is></c></row>'
        )
    dimension = f"A1:A{count}" if count else "A1"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_REL}">'
        f'<dimension ref="{dimension}"/>'
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="16.5"/>'
        '<cols><col min="1" max="1" width="64" customWidth="1"/></cols>'
        f'<sheetData>{"".join(cells)}</sheetData>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        "</worksheet>"
    ).encode("utf-8")


def sheet_part_paths(archive: zipfile.ZipFile) -> dict[str, str]:
    """Map each sheet name to its worksheet part inside the archive."""
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {rel.get("Id"): rel.get("Target", "") for rel in rels.iter(f"{{{NS_PKG_REL}}}Relationship")}
    paths: dict[str, str] = {}
    for sheet in workbook.iter(f"{{{NS_MAIN}}}sheet"):
        target = targets.get(sheet.get(f"{{{NS_REL}}}id"), "")
        if not target:
            continue
        # Targets are usually relative to xl/, but some writers use absolute /xl/... paths.
        part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        paths[sheet.get("name", "").strip()] = part
    return paths


def template_sheet_names(template_path: str | Path) -> list[str]:
    with zipfile.ZipFile(template_path) as archive:
        return list(sheet_part_paths(archive))


def missing_template_sheets(template_path: str | Path) -> list[str]:
    names = set(template_sheet_names(template_path))
    return [name for name in INTEGRATED_REQUIRED_SHEETS if name not in names]


def write_integrated_workbook(
    template_path: str | Path,
    output_path: str | Path,
    sheet_lines: dict[str, list[bytes]],
) -> WorkbookExportResult:
    """Copy the template, replacing the named sheets' rows with the given master lines."""
    template = Path(template_path)
    output = Path(output_path)
    if template.resolve() == output.resolve():
        raise ValueError("템플릿 엑셀과 저장할 엑셀이 같은 파일입니다. 다른 파일명을 지정하세요.")
    with zipfile.ZipFile(template) as archive:
        parts = sheet_part_paths(archive)
        missing = [name for name in INTEGRATED_REQUIRED_SHEETS if name not in parts]
        if missing:
            raise ValueError("템플릿 엑셀에 필수 시트가 없습니다: " + ", ".join(missing))
        unknown = [name for name in sheet_lines if name not in parts]
        if unknown:
            raise ValueError("템플릿 엑셀에 없는 시트입니다: " + ", ".join(unknown))
        prepared = {name: prepare_sheet_rows(lines) for name, lines in sheet_lines.items()}
        replaced = {parts[name]: build_sheet_xml(sheet.rows) for name, sheet in prepared.items()}

        # Write beside the target and swap in at the end, so a failure midway never
        # leaves a half-written workbook under the final name.
        temp_path = output.with_name(output.name + ".tmp")
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as out:
            for info in archive.infolist():
                data = replaced.get(info.filename)
                if data is None:
                    out.writestr(info, archive.read(info.filename))
                else:
                    out.writestr(info.filename, data, compress_type=zipfile.ZIP_DEFLATED)
    temp_path.replace(output)
    return WorkbookExportResult(
        path=output,
        row_counts={name: len(sheet.rows) for name, sheet in prepared.items()},
        padded_counts={name: sheet.padded for name, sheet in prepared.items() if sheet.padded},
        dropped_counts={name: sheet.dropped for name, sheet in prepared.items() if sheet.dropped},
    )
