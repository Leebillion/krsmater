"""Product classification rules shared by the desktop app and the web app."""

from __future__ import annotations

from .core import MasterLine

FF_INCLUDE_KEYWORDS = ("1편", "2편")
FF_EXCLUDE_KEYWORDS = ("주문", "예", "예약")


def is_ff_candidate_line(line: MasterLine) -> bool:
    text = f"{line.long_name} {line.short_name} {line.display_text}".casefold()
    include = any(keyword.casefold() in text for keyword in FF_INCLUDE_KEYWORDS)
    exclude = any(keyword.casefold() in text for keyword in FF_EXCLUDE_KEYWORDS)
    return include and not exclude
