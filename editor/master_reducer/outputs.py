"""Definitions and assembly for the four weekly output files.

The reduction work (excluding rows) happens once in the app; each output then applies
its own final filter and DB appends on top of that shared result, so one editing pass
produces all four files.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .core import MasterLine, OutputRows, build_output, write_master_file
from .db import SOURCE_BUNDLE, SOURCE_PAID, SOURCE_SERVICE, SOURCE_SHORT, product_source


OUTPUT_LEADER = "leader"
OUTPUT_MEMBER = "member"
OUTPUT_PDA_FULL = "pda_full"
OUTPUT_PDA_SHORT = "pda_short"
OUTPUT_FULL_MASTER = "full_master"
OUTPUT_CLOSED_MASTER = "closed_master"

BASE_REDUCED = "reduced"
BASE_SHORT_MASTER = "short_master"
BASE_FULL_MASTER = "full_master"
BASE_CLOSED_MASTER = "closed_master"
BASE_LABELS = {
    BASE_REDUCED: "감축본",
    BASE_SHORT_MASTER: "본사 단축 마스터",
    BASE_FULL_MASTER: "전체 마스터",
    BASE_CLOSED_MASTER: "폐점 마스터",
}
BASE_FILE_LABELS = {
    BASE_REDUCED: "신규 마스터",
    BASE_SHORT_MASTER: "단축 마스터",
    BASE_FULL_MASTER: "전체 마스터",
    BASE_CLOSED_MASTER: "폐점 마스터",
}

FILTER_FF = "ff"
FILTER_TOBACCO = "tobacco"

ALL_APPEND_SOURCES = (SOURCE_PAID, SOURCE_BUNDLE, SOURCE_SHORT, SOURCE_SERVICE)
# 팀장용/팀원용은 PDA와 달리 단축상품 DB는 기본으로 붙이지 않는다.
LEADER_DEFAULT_APPEND = (SOURCE_PAID, SOURCE_BUNDLE, SOURCE_SERVICE)
MEMBER_DEFAULT_APPEND = (SOURCE_BUNDLE, SOURCE_SERVICE)
FULL_MASTER_DEFAULT_APPEND = (SOURCE_PAID,)


RESTORE_TOBACCO = "restore_tobacco"
RESTORE_FF = "restore_ff"
ALL_RESTORE_GROUPS = (RESTORE_TOBACCO, RESTORE_FF)
GROUP_LABELS = {RESTORE_TOBACCO: "담배 복구", RESTORE_FF: "FF 복구"}


@dataclass(frozen=True)
class OutputSpec:
    key: str
    label: str
    base: str
    exclude_filter: str | None
    default_appends: tuple[str, ...]
    filename_suffix: str
    description: str
    restore_groups: tuple[str, ...] = ()
    # group_key -> keywords; a restored row matching any keyword is dropped for this
    # spec only (other outputs restoring the same group are unaffected).
    restore_exclude_keywords: dict[str, tuple[str, ...]] = field(default_factory=dict)
    # Set when the receiving device expects one exact name (PDA Short -> master.txt).
    fixed_filename: str = ""


OUTPUT_SPECS: tuple[OutputSpec, ...] = (
    OutputSpec(
        key=OUTPUT_LEADER,
        label="팀장용",
        base=BASE_REDUCED,
        exclude_filter=FILTER_FF,
        default_appends=LEADER_DEFAULT_APPEND,
        filename_suffix="_팀장용",
        description="감축본에서 FF 상품을 최종 삭제하고, 감축 때 지운 담배는 되살립니다. 종량제·번들·서비스 DB가 기본 포함됩니다.",
        restore_groups=(RESTORE_TOBACCO,),
    ),
    OutputSpec(
        key=OUTPUT_MEMBER,
        label="팀원용",
        base=BASE_REDUCED,
        exclude_filter=FILTER_TOBACCO,
        default_appends=MEMBER_DEFAULT_APPEND,
        filename_suffix="_팀원용",
        description="감축본에서 담배 상품을 최종 삭제하고, 감축 때 지운 FF는 되살립니다(밀박스 제외). 번들·서비스 DB가 기본 포함됩니다.",
        restore_groups=(RESTORE_FF,),
        restore_exclude_keywords={RESTORE_FF: ("밀박스",)},
    ),
    OutputSpec(
        key=OUTPUT_PDA_SHORT,
        label="PDA Short",
        base=BASE_SHORT_MASTER,
        exclude_filter=None,
        default_appends=ALL_APPEND_SOURCES,
        filename_suffix="_PDA_SHORT",
        description="본사 단축 마스터 + 종량제 + 번들 + 단축 바코드 + 서비스. PDA는 용량 제한이 없어 담배·FF를 모두 되살립니다.",
        restore_groups=ALL_RESTORE_GROUPS,
        fixed_filename="master.txt",
    ),
    # 전체·폐점 마스터는 감축(기존 삭제 실행, 담배·FF 일괄 삭제 등)의 영향을 받지 않는 원본이다.
    # 그래서 이 세 출력은 최종 제외 필터도 복구 그룹도 두지 않고, 원본 전체 뒤에 체크한 DB만 붙인다.
    OutputSpec(
        key=OUTPUT_PDA_FULL,
        label="PDA Full",
        base=BASE_FULL_MASTER,
        exclude_filter=None,
        default_appends=ALL_APPEND_SOURCES,
        filename_suffix="_PDA_FULL",
        description="상단에서 불러온 전체 마스터 + 종량제 + 번들 + 단축 바코드 + 서비스.",
    ),
    OutputSpec(
        key=OUTPUT_FULL_MASTER,
        label="Full 마스터",
        base=BASE_FULL_MASTER,
        exclude_filter=None,
        default_appends=FULL_MASTER_DEFAULT_APPEND,
        filename_suffix="_FULL_MASTER",
        description="상단에서 불러온 전체 마스터 + 종량제. 통합 엑셀의 '전체' 시트가 됩니다.",
    ),
    OutputSpec(
        key=OUTPUT_CLOSED_MASTER,
        label="폐점 마스터",
        base=BASE_CLOSED_MASTER,
        exclude_filter=None,
        default_appends=(),
        filename_suffix="_폐점마스터",
        description="상단에서 불러온 폐점 마스터 원문 그대로. 통합 엑셀의 '폐점' 시트가 됩니다.",
    ),
)

OUTPUT_SPEC_BY_KEY: dict[str, OutputSpec] = {spec.key: spec for spec in OUTPUT_SPECS}


@dataclass(frozen=True)
class OutputContext:
    """Everything the four outputs are assembled from, snapshotted at save time."""

    reduced_lines: list[MasterLine]
    newline: bytes
    short_master_lines: list[MasterLine] = field(default_factory=list)
    full_master_lines: list[MasterLine] = field(default_factory=list)
    closed_master_lines: list[MasterLine] = field(default_factory=list)
    tobacco_barcodes: set[str] = field(default_factory=set)
    ff_barcodes: set[str] = field(default_factory=set)
    append_lines_by_source: dict[str, list[bytes]] = field(default_factory=dict)
    restore_lines_by_group: dict[str, list[bytes]] = field(default_factory=dict)

    def base_lines(self, spec: OutputSpec) -> list[MasterLine]:
        if spec.base == BASE_SHORT_MASTER:
            return self.short_master_lines
        if spec.base == BASE_FULL_MASTER:
            return self.full_master_lines
        if spec.base == BASE_CLOSED_MASTER:
            return self.closed_master_lines
        return self.reduced_lines

    def exclude_barcodes(self, spec: OutputSpec) -> set[str]:
        if spec.exclude_filter == FILTER_FF:
            return self.ff_barcodes
        if spec.exclude_filter == FILTER_TOBACCO:
            return self.tobacco_barcodes
        return set()

    def restore_groups(self, spec: OutputSpec) -> list[tuple[str, list[bytes]]]:
        """(group_key, lines) actually offered to this spec, after its keyword filter."""
        result = []
        for group_key in spec.restore_groups:
            lines = self.restore_lines_by_group.get(group_key, [])
            keywords = spec.restore_exclude_keywords.get(group_key, ())
            if keywords:
                lines = [raw for raw in lines if not line_matches_keywords(raw, keywords)]
            result.append((group_key, lines))
        return result

    def restore_line_count(self, spec: OutputSpec) -> int:
        return sum(len(lines) for _key, lines in self.restore_groups(spec))

    def restore_keyword_excluded_count(self, spec: OutputSpec, group_key: str) -> int:
        """Rows this spec's keyword filter dropped from the group, before dedup."""
        keywords = spec.restore_exclude_keywords.get(group_key, ())
        if not keywords:
            return 0
        lines = self.restore_lines_by_group.get(group_key, [])
        return sum(1 for raw in lines if line_matches_keywords(raw, keywords))

    def is_available(self, spec: OutputSpec) -> bool:
        return bool(self.base_lines(spec))

    def unavailable_reason(self, spec: OutputSpec) -> str:
        return f"상단 '{BASE_FILE_LABELS[spec.base]}' 파일을 선택해야 저장할 수 있습니다."


@dataclass(frozen=True)
class OutputPlan:
    spec: OutputSpec
    path: Path
    append_sources: tuple[str, ...]


@dataclass(frozen=True)
class OutputResult:
    plan: OutputPlan
    rows: OutputRows

    def summary(self) -> str:
        parts = [f"기본 {len(self.rows.kept):,}행"]
        for group_key, count in self.rows.append_counts.items():
            if count:
                parts.append(f"{group_label(group_key)} {count:,}행")
        return f"{self.plan.spec.label}: {' + '.join(parts)} = {self.rows.total:,}행"


def group_label(group_key: str) -> str:
    if group_key in GROUP_LABELS:
        return GROUP_LABELS[group_key]
    return product_source(group_key).label


def line_matches_keywords(raw_line: bytes, keywords: tuple[str, ...]) -> bool:
    if not keywords:
        return False
    line = MasterLine(index=0, raw_line=raw_line)
    text = f"{line.long_name} {line.short_name} {line.display_text}".casefold()
    return any(keyword.casefold() in text for keyword in keywords)


def compose_output(context: OutputContext, plan: OutputPlan) -> OutputRows:
    # 감축 때 지운 카테고리를 되살리는 그룹을 DB append보다 먼저 넣는다.
    append_groups: list[tuple[str, list[bytes]]] = [
        (group_key, lines) for group_key, lines in context.restore_groups(plan.spec) if lines
    ]
    append_groups.extend(
        (source_key, context.append_lines_by_source.get(source_key, []))
        for source_key in plan.append_sources
    )
    return build_output(
        context.base_lines(plan.spec),
        context.exclude_barcodes(plan.spec),
        append_groups,
    )


def output_raw_lines(rows: OutputRows) -> list[bytes]:
    """The rows exactly as write_output puts them in the file, without line endings."""
    return [line.raw_line for line in rows.kept] + list(rows.appended)


def write_output(context: OutputContext, plan: OutputPlan) -> OutputResult:
    rows = compose_output(context, plan)
    write_master_file(plan.path, rows.kept, context.newline, rows.appended)
    return OutputResult(plan=plan, rows=rows)


def write_outputs(context: OutputContext, plans: list[OutputPlan]) -> list[OutputResult]:
    return [write_output(context, plan) for plan in plans]


# 본사 파일명 앞의 점포/파일 코드(예: 'h140100003_new_01_20260831'의 'h140100003').
_SOURCE_CODE_PREFIX = re.compile(r"^[hH]\d+_?")


def default_prefix_from_source(stem: str) -> str:
    """Drop the leading h-code from a source file stem; the row count takes its place."""
    return _SOURCE_CODE_PREFIX.sub("", stem)


def default_filename(spec: OutputSpec, prefix: str, row_count: int | None = None) -> str:
    """'<행수>_<접두어><접미어>.txt'. PDA Short keeps its fixed name for the device.

    The row count is left out until it is known (or for outputs that cannot be saved).
    """
    if spec.fixed_filename:
        return spec.fixed_filename
    parts = [str(row_count)] if row_count is not None else []
    if prefix.strip("_"):
        parts.append(prefix.strip("_"))
    return f"{'_'.join(parts)}{spec.filename_suffix}.txt"


def default_workbook_filename(prefix: str) -> str:
    name = prefix.strip("_")
    return f"{name}_통합마스터.xlsx" if name else "통합마스터.xlsx"
