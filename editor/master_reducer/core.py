from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Iterable, Literal, Sequence


ENCODING = "cp949"
KEY_BARCODE = "barcode"
KEY_FULL_ROW = "full_row"
BARCODE_BYTES = 13
LONG_NAME_BYTES = 30
SHORT_NAME_BYTES = 14
KeyMode = Literal["barcode", "full_row"]


@dataclass(frozen=True)
class MasterLine:
    index: int
    raw_line: bytes

    # These decode the CP949 row on every access; searching, sorting and the FF rule
    # read them many times per row, so each is computed once. Safe because they
    # depend only on raw_line, which is immutable.
    @cached_property
    def display_text(self) -> str:
        return self.barcode + decode_row_tail_text(self.raw_line)

    @cached_property
    def barcode(self) -> str:
        return extract_barcode(self.raw_line)

    @cached_property
    def long_name(self) -> str:
        return extract_long_name(self.raw_line)

    @cached_property
    def short_name(self) -> str:
        return extract_short_name(self.raw_line)

    def key(self, mode: KeyMode) -> bytes:
        if mode == KEY_FULL_ROW:
            return self.raw_line
        return barcode_key(self.raw_line)


@dataclass(frozen=True)
class MasterFile:
    path: Path
    lines: list[MasterLine]
    newline: bytes


@dataclass(frozen=True)
class CompareResult:
    added: list[MasterLine]
    deleted: list[MasterLine]


@dataclass(frozen=True)
class OutputRows:
    kept: list[MasterLine]
    appended: list[bytes]
    append_counts: dict[str, int]

    @property
    def total(self) -> int:
        return len(self.kept) + len(self.appended)


def split_line_ending(data: bytes) -> tuple[bytes, bytes]:
    if data.endswith(b"\r\n"):
        return data[:-2], b"\r\n"
    if data.endswith(b"\n"):
        return data[:-1], b"\n"
    if data.endswith(b"\r"):
        return data[:-1], b"\r"
    return data, b""


def detect_newline(content: bytes) -> bytes:
    counts = Counter()
    i = 0
    while i < len(content):
        if content[i : i + 2] == b"\r\n":
            counts[b"\r\n"] += 1
            i += 2
        elif content[i : i + 1] == b"\n":
            counts[b"\n"] += 1
            i += 1
        elif content[i : i + 1] == b"\r":
            counts[b"\r"] += 1
            i += 1
        else:
            i += 1
    if not counts:
        return b"\r\n"
    return counts.most_common(1)[0][0]


def read_master_file(path: str | Path) -> MasterFile:
    file_path = Path(path)
    content = file_path.read_bytes()
    newline = detect_newline(content)
    raw_lines = content.splitlines(keepends=True)
    lines: list[MasterLine] = []
    for index, raw in enumerate(raw_lines):
        body, _ending = split_line_ending(raw)
        if body:
            lines.append(MasterLine(index=index, raw_line=body))
    return MasterFile(path=file_path, lines=lines, newline=newline)


def barcode_key(raw_line: bytes) -> bytes:
    return raw_line[:BARCODE_BYTES].strip()


def extract_barcode(raw_line: bytes) -> str:
    return barcode_key(raw_line).decode("ascii", errors="ignore").strip()


def text_decode_score(text: str) -> int:
    score = 0
    for char in text:
        code = ord(char)
        if char == "\ufffd":
            score -= 4
        elif 0xAC00 <= code <= 0xD7A3:
            score += 3
        elif char.isascii() and (char.isalnum() or char.isspace() or char in "()-_,./+&[]"):
            score += 1
        elif char.isprintable():
            score += 0
        else:
            score -= 2
    return score


def decode_display_text(raw: bytes) -> str:
    cp949_text = raw.decode(ENCODING, errors="replace")
    try:
        utf8_text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return cp949_text
    return utf8_text if text_decode_score(utf8_text) > text_decode_score(cp949_text) else cp949_text


def decode_row_tail_text(raw_line: bytes) -> str:
    return decode_display_text(raw_line[BARCODE_BYTES:])


def split_text_by_cp949_width(text: str, first_width: int, second_width: int) -> tuple[str, str, str]:
    first_chars: list[str] = []
    second_chars: list[str] = []
    tail_chars: list[str] = []
    first_used = 0
    second_used = 0

    for char in text:
        try:
            char_width = len(char.encode(ENCODING))
        except UnicodeEncodeError:
            char_width = len(char.encode("utf-8"))
        if first_used + char_width <= first_width:
            first_chars.append(char)
            first_used += char_width
        elif second_used + char_width <= second_width:
            second_chars.append(char)
            second_used += char_width
        else:
            tail_chars.append(char)
    return "".join(first_chars), "".join(second_chars), "".join(tail_chars)


def decode_text(raw: bytes) -> str:
    return decode_display_text(raw).strip()


def decode_tail_text(raw: bytes) -> str:
    return decode_display_text(raw).rstrip()


def extract_long_name(raw_line: bytes) -> str:
    long_name, _short_name, _tail_text = split_text_by_cp949_width(
        decode_row_tail_text(raw_line),
        LONG_NAME_BYTES,
        SHORT_NAME_BYTES,
    )
    return long_name.strip()


def extract_short_name(raw_line: bytes) -> str:
    _long_name, short_name, _tail_text = split_text_by_cp949_width(
        decode_row_tail_text(raw_line),
        LONG_NAME_BYTES,
        SHORT_NAME_BYTES,
    )
    return short_name.strip()


def extract_tail_text(raw_line: bytes) -> str:
    _long_name, _short_name, tail_text = split_text_by_cp949_width(
        decode_row_tail_text(raw_line),
        LONG_NAME_BYTES,
        SHORT_NAME_BYTES,
    )
    return tail_text.rstrip()


def fit_text_bytes(text: str, width: int) -> bytes:
    fitted = truncate_text_to_bytes(text, width)
    return fitted.encode(ENCODING).ljust(width, b" ")


def truncate_text_to_bytes(text: str, width: int, encoding: str = ENCODING) -> str:
    if width <= 0:
        return ""
    current = text
    while current:
        try:
            encoded = current.encode(encoding)
        except UnicodeEncodeError:
            current = current[:-1]
            continue
        if len(encoded) <= width:
            return current
        current = current[:-1]
    return ""


def tail_text_to_bytes(text: str, width: int, encoding: str = ENCODING) -> str:
    """Keep as many trailing characters of text as fit within width bytes.

    Mirrors truncate_text_to_bytes but from the end, without splitting a multi-byte
    character -- reversing the string lets the same prefix-truncation logic apply.
    """
    return truncate_text_to_bytes(text[::-1], width, encoding)[::-1]


def measure_text_bytes(text: str, encoding: str = ENCODING) -> int:
    try:
        return len(text.encode(encoding))
    except UnicodeEncodeError:
        return len(truncate_text_to_bytes(text, 10**9, encoding).encode(encoding))


def compose_fixed_width_row(barcode: str, long_name: str, short_name: str, tail_text: str = "") -> bytes:
    barcode_value = barcode.strip()
    barcode_bytes = barcode_value.encode("ascii")
    if len(barcode_bytes) > BARCODE_BYTES:
        raise ValueError(f"바코드는 {BARCODE_BYTES}byte를 넘길 수 없습니다.")
    tail_bytes = truncate_text_to_bytes(tail_text, 10**9).encode(ENCODING) if tail_text else b""
    return b"".join(
        [
            barcode_bytes.ljust(BARCODE_BYTES, b" "),
            fit_text_bytes(long_name.strip(), LONG_NAME_BYTES),
            fit_text_bytes(short_name.strip(), SHORT_NAME_BYTES),
            tail_bytes,
        ]
    )


def replace_short_name(raw_line: bytes, new_short_name: str) -> bytes:
    """Swap only the 14-byte short-name field, keeping barcode/long-name/tail as-is."""
    short_start = BARCODE_BYTES + LONG_NAME_BYTES
    short_end = short_start + SHORT_NAME_BYTES
    padded = raw_line.ljust(short_end, b" ")
    return padded[:short_start] + fit_text_bytes(new_short_name.strip(), SHORT_NAME_BYTES) + padded[short_end:]


def normalize_raw_line_to_cp949(raw_line: bytes) -> bytes:
    """Rebuild a master row as CP949 fixed-width bytes for legacy file compatibility."""
    body, _ending = split_line_ending(raw_line)
    if not body:
        return b""
    return compose_fixed_width_row(
        extract_barcode(body),
        extract_long_name(body),
        extract_short_name(body),
        extract_tail_text(body),
    )


def compare_master_files(old_file: MasterFile, new_file: MasterFile, mode: KeyMode) -> CompareResult:
    old_counts = Counter(line.key(mode) for line in old_file.lines)
    new_counts = Counter(line.key(mode) for line in new_file.lines)

    added_allowance = new_counts - old_counts
    deleted_allowance = old_counts - new_counts

    added: list[MasterLine] = []
    for line in new_file.lines:
        key = line.key(mode)
        if added_allowance[key] > 0:
            added.append(line)
            added_allowance[key] -= 1

    deleted: list[MasterLine] = []
    for line in old_file.lines:
        key = line.key(mode)
        if deleted_allowance[key] > 0:
            deleted.append(line)
            deleted_allowance[key] -= 1

    return CompareResult(added=added, deleted=deleted)


def remove_lines_by_index(lines: Iterable[MasterLine], deleted_indexes: set[int]) -> list[MasterLine]:
    return [line for line in lines if line.index not in deleted_indexes]


def indexes_for_barcodes(lines: Iterable[MasterLine], barcodes: Iterable[str]) -> set[int]:
    barcode_set = {barcode.strip() for barcode in barcodes if barcode.strip()}
    if not barcode_set:
        return set()
    return {line.index for line in lines if line.barcode in barcode_set}


def prepend_raw_lines(master_file: MasterFile, raw_lines: Iterable[bytes]) -> MasterFile:
    bodies = []
    for raw_line in raw_lines:
        body, _ending = split_line_ending(raw_line)
        if body:
            bodies.append(body)
    if not bodies:
        return master_file

    min_index = min((line.index for line in master_file.lines), default=0)
    start_index = min_index - len(bodies)
    inserted_lines = [
        MasterLine(index=start_index + offset, raw_line=body)
        for offset, body in enumerate(bodies)
    ]
    return MasterFile(
        path=master_file.path,
        lines=inserted_lines + master_file.lines,
        newline=master_file.newline,
    )


def write_master_file(
    output_path: str | Path,
    lines: Iterable[MasterLine],
    newline: bytes,
    appended_raw_lines: Iterable[bytes] = (),
) -> None:
    out = bytearray()
    for line in lines:
        out.extend(line.raw_line)
        out.extend(newline)
    for raw_line in appended_raw_lines:
        body, _ending = split_line_ending(raw_line)
        if not body:
            continue
        out.extend(body)
        out.extend(newline)
    Path(output_path).write_bytes(bytes(out))


def lines_from_raw(raw_lines: Iterable[bytes], start_index: int = 0) -> list[MasterLine]:
    return [
        MasterLine(index=start_index + offset, raw_line=raw_line)
        for offset, raw_line in enumerate(raw_lines)
    ]


def build_output(
    base_lines: Iterable[MasterLine],
    exclude_barcodes: Iterable[str] = (),
    append_groups: Sequence[tuple[str, Sequence[bytes]]] = (),
) -> OutputRows:
    """Assemble one output file: base rows minus excluded barcodes, plus non-duplicate DB rows.

    Append groups are applied in order and deduplicated against the kept rows *and*
    against rows already appended by earlier groups, so a barcode present in two
    product DBs is written only once. Excluded barcodes stay excluded: a product DB
    row carrying an excluded barcode is not appended back in. Counts are per group.
    """
    lines = list(base_lines)
    excluded = {barcode.strip() for barcode in exclude_barcodes if barcode.strip()}
    kept = remove_lines_by_index(lines, indexes_for_barcodes(lines, excluded))

    appended: list[bytes] = []
    append_counts: dict[str, int] = {}
    for name, raw_lines in append_groups:
        allowed = [raw_line for raw_line in raw_lines if extract_barcode(raw_line) not in excluded]
        existing = [*kept, *lines_from_raw(appended, start_index=-len(appended))]
        picked = [
            normalized
            for normalized in (
                normalize_raw_line_to_cp949(raw_line)
                for raw_line in non_duplicate_appends(existing, allowed)
            )
            if normalized
        ]
        append_counts[name] = len(picked)
        appended.extend(picked)
    return OutputRows(kept=kept, appended=appended, append_counts=append_counts)


def non_duplicate_appends(existing_lines: Iterable[MasterLine], db_raw_lines: Iterable[bytes]) -> list[bytes]:
    existing_barcodes = {barcode_key(line.raw_line) for line in existing_lines if barcode_key(line.raw_line)}
    selected: list[bytes] = []
    for raw_line in db_raw_lines:
        key = barcode_key(raw_line)
        if not key or key in existing_barcodes:
            continue
        selected.append(raw_line)
        existing_barcodes.add(key)
    return selected
