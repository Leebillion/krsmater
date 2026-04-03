import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


KOREAN_RE = re.compile(r"[가-힣]")
ALNUM_RE = re.compile(r"[가-힣A-Za-z0-9]")
CODE_RE = re.compile(r"\d{8,14}")
TESSERACT_CANDIDATES = [
    os.environ.get("TESSERACT_CMD", ""),
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
]


@dataclass
class Token:
    text: str
    x: int
    y: int
    w: int
    h: int
    conf: float

    @property
    def center_x(self) -> float:
        return self.x + self.w / 2

    @property
    def center_y(self) -> float:
        return self.y + self.h / 2


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "image path is required"}, ensure_ascii=False))
        return 1

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        print(json.dumps({"error": "image file not found"}, ensure_ascii=False))
        return 1

    configure_tesseract()

    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        print(json.dumps({"error": "image decode failed"}, ensure_ascii=False))
        return 1

    corrected = deskew_document(image)
    rows, warnings = best_ocr_result(corrected)

    print(json.dumps({"ok": True, "items": rows, "warnings": warnings}, ensure_ascii=False))
    return 0


def configure_tesseract() -> None:
    for candidate in TESSERACT_CANDIDATES:
        if candidate and Path(candidate).exists():
            pytesseract.pytesseract.tesseract_cmd = candidate
            break

    tessdata_dir = Path(__file__).with_name("tessdata")
    if tessdata_dir.exists():
        os.environ["TESSDATA_PREFIX"] = str(tessdata_dir)


def deskew_document(image: np.ndarray) -> np.ndarray:
    resized = resize_for_processing(image)
    ratio_x = image.shape[1] / resized.shape[1]
    ratio_y = image.shape[0] / resized.shape[0]

    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:10]

    document = None
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) == 4:
            document = approx.reshape(4, 2).astype("float32")
            break

    corrected = image
    if document is not None:
        document[:, 0] *= ratio_x
        document[:, 1] *= ratio_y
        corrected = four_point_transform(image, document)

    if corrected.shape[1] > corrected.shape[0]:
        corrected = cv2.rotate(corrected, cv2.ROTATE_90_CLOCKWISE)

    return corrected


def resize_for_processing(image: np.ndarray, max_size: int = 1600) -> np.ndarray:
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= max_size:
        return image.copy()
    scale = max_size / float(longest)
    return cv2.resize(image, (int(width * scale), int(height * scale)))


def four_point_transform(image: np.ndarray, points: np.ndarray) -> np.ndarray:
    rect = order_points(points)
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_width = int(max(width_a, width_b))
    max_height = int(max(height_a, height_b))
    destination = np.array(
        [[0, 0], [max_width - 1, 0], [max_width - 1, max_height - 1], [0, max_height - 1]],
        dtype="float32",
    )
    matrix = cv2.getPerspectiveTransform(rect, destination)
    return cv2.warpPerspective(image, matrix, (max_width, max_height))


def order_points(points: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = points.sum(axis=1)
    diff = np.diff(points, axis=1)
    rect[0] = points[np.argmin(s)]
    rect[2] = points[np.argmax(s)]
    rect[1] = points[np.argmin(diff)]
    rect[3] = points[np.argmax(diff)]
    return rect


def best_ocr_result(image: np.ndarray) -> tuple[list[dict], list[str]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    variants = [
      ("base", image),
      ("rot_cw", cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)),
      ("rot_ccw", cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)),
      ("rot_180", cv2.rotate(image, cv2.ROTATE_180)),
      ("gray", cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)),
    ]

    best_rows: list[dict] = []
    best_warnings: list[str] = ["OCR 결과가 없습니다."]
    best_score = -1

    for _, variant in variants:
        rows, warnings = extract_text_rows(variant)
        score = score_rows(rows)
        if score > best_score:
            best_rows = rows
            best_warnings = warnings
            best_score = score

    merged_rows = merge_rows_by_barcode(best_rows)

    if best_score <= 0 or len(merged_rows) < 14:
        extra_candidates: list[dict] = []
        for _, variant in variants:
            token_rows, _ = extract_rows_from_tokens(extract_tokens(variant), variant.shape[1])
            extra_candidates.extend(token_rows)
        merged_rows = merge_rows_by_barcode(merged_rows + extra_candidates)

    warnings = list(best_warnings)
    if len(merged_rows) < 14:
        warnings.append("일부 행은 OCR 품질 문제로 누락되거나 불완전할 수 있어 표에서 직접 수정이 필요합니다.")

    return reindex_rows(merged_rows), warnings


def score_rows(rows: list[dict]) -> int:
    score = 0
    for row in rows:
        barcode = row.get("barcode", "")
        name = row.get("name", "")
        if len(barcode) >= 8:
            score += 2
        if len(barcode) == 13:
            score += 1
        if len(re.findall(r"[가-힣]", name)) >= 2:
            score += 3
    return score


def preprocess_for_ocr(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    filtered = cv2.bilateralFilter(gray, 7, 30, 30)
    return cv2.adaptiveThreshold(filtered, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11)


def extract_text_rows(image: np.ndarray) -> tuple[list[dict], list[str]]:
    threshold = preprocess_for_ocr(image)
    text = pytesseract.image_to_string(threshold, lang="kor+eng", config="--oem 3 --psm 6")

    rows: list[dict] = []
    warnings: list[str] = []
    header_found = False

    for raw_line in text.splitlines():
        line = normalize_line(raw_line)
        if not line:
            continue
        if "상품코드" in line and "상품명" in line:
            header_found = True
            continue
        rows.extend(parse_text_line(line))

    if not header_found:
        warnings.append("헤더 행을 찾지 못해 자동 추정으로 처리했습니다.")

    return reindex_rows(merge_rows_by_barcode(rows)), warnings


def normalize_line(value: str) -> str:
    line = re.sub(r"\s+", " ", value).strip()
    line = line.replace("Ｌ", "L").replace("[", "L").replace("|", " ")
    return line


def parse_text_line(line: str) -> list[dict]:
    matches = list(CODE_RE.finditer(line))
    if not matches:
        return []

    rows: list[dict] = []
    for index, match in enumerate(matches):
        barcode = match.group(0)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
        remainder = clean_name(line[start:end])
        if not remainder:
            remainder = clean_name(line[:match.start()])
        if not remainder:
            remainder = ""
        rows.append({"barcode": barcode, "name": remainder})
    return rows


def clean_name(value: str) -> str:
    name = value.strip()
    name = re.sub(r"(\d)\s+[aA]$", r"\1L", name)
    name = re.sub(r"^[^\w가-힣]+", "", name).strip()
    if "(신)" in name:
        name = name.split("(신)", 1)[0] + "(신)"
    name = re.sub(r"\s*[-:]+\s*\d+$", "", name)
    name = re.sub(r"\s+\d{1,4}$", "", name)
    name = re.sub(r"\s+[A-Za-z]$", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def extract_tokens(image: np.ndarray) -> list[Token]:
    threshold = preprocess_for_ocr(image)
    data = pytesseract.image_to_data(
        threshold,
        lang="kor+eng",
        config="--oem 3 --psm 6",
        output_type=pytesseract.Output.DICT,
    )

    tokens: list[Token] = []
    total = len(data["text"])
    for index in range(total):
        text = clean_token_text(data["text"][index])
        if not text:
            continue
        try:
            conf = float(data["conf"][index])
        except Exception:
            conf = -1
        if conf < 18:
            continue
        tokens.append(
            Token(
                text=text,
                x=int(data["left"][index]),
                y=int(data["top"][index]),
                w=int(data["width"][index]),
                h=int(data["height"][index]),
                conf=conf,
            )
        )
    return tokens


def clean_token_text(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        return ""
    value = value.replace("|", "1")
    value = re.sub(r"\s+", " ", value)
    return value


def extract_rows_from_tokens(tokens: list[Token], width: int) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    if not tokens:
        return [], ["OCR 결과가 없습니다."]

    lines = group_tokens_by_line(tokens)
    rows: list[dict] = []
    for line in lines:
        row = parse_token_line(line, width)
        if row:
            rows.append(row)

    return reindex_rows(merge_rows_by_barcode(rows)), warnings


def group_tokens_by_line(tokens: list[Token]) -> list[list[Token]]:
    sorted_tokens = sorted(tokens, key=lambda token: (token.center_y, token.x))
    median_height = np.median([token.h for token in sorted_tokens]) if sorted_tokens else 18
    threshold = max(12, int(median_height * 0.75))

    lines: list[list[Token]] = []
    for token in sorted_tokens:
        if not lines:
            lines.append([token])
            continue
        current = lines[-1]
        average_y = sum(item.center_y for item in current) / len(current)
        if abs(token.center_y - average_y) <= threshold:
            current.append(token)
        else:
            lines.append([token])

    for line in lines:
        line.sort(key=lambda token: token.x)
    return lines


def parse_token_line(tokens: list[Token], width: int) -> dict | None:
    if not tokens:
        return None

    barcode = ""
    for token in sorted(tokens, key=lambda item: item.x):
        digits = re.sub(r"\D", "", token.text)
        if len(digits) >= 8:
            barcode = digits[:13]
            break

    if not barcode:
        return None

    center_tokens = [token for token in tokens if width * 0.16 <= token.center_x <= width * 0.82]
    name_parts = []
    for token in center_tokens:
        digits = re.sub(r"\D", "", token.text)
        if digits == barcode:
            continue
        if CODE_RE.fullmatch(digits or "x"):
            continue
        if ALNUM_RE.search(token.text):
            name_parts.append(token.text)

    name = clean_name(" ".join(name_parts))
    return {"barcode": barcode, "name": name}


def merge_rows_by_barcode(rows: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for row in rows:
        barcode = re.sub(r"\D", "", row.get("barcode", ""))
        if len(barcode) < 8:
            continue
        name = clean_name(row.get("name", ""))
        current = merged.get(barcode)
        if current is None:
            merged[barcode] = {"barcode": barcode, "name": name}
            continue
        if len(name) > len(current.get("name", "")):
            current["name"] = name
    return list(merged.values())


def reindex_rows(rows: list[dict]) -> list[dict]:
    ordered = sorted(rows, key=lambda row: row.get("barcode", ""))
    for index, row in enumerate(ordered, start=1):
        row["rowNumber"] = index
    return ordered


if __name__ == "__main__":
    raise SystemExit(main())
