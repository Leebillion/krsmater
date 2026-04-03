import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from PIL import Image
import pypdfium2 as pdfium

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None


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
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "image path is required"}, ensure_ascii=False))
            return 1

        image_path = Path(sys.argv[1])
        if not image_path.exists():
            print(json.dumps({"error": "image file not found"}, ensure_ascii=False))
            return 1

        configure_tesseract()

        images = load_images(image_path)
        if not images:
            print(json.dumps({"error": "image decode failed"}, ensure_ascii=False))
            return 1

        rows, warnings = run_ocr_for_images(images)

        print(json.dumps({"ok": True, "items": rows, "warnings": warnings}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": format_runtime_error(error)}, ensure_ascii=False))
        return 1


def configure_tesseract() -> None:
    for candidate in TESSERACT_CANDIDATES:
        if candidate and Path(candidate).exists():
            pytesseract.pytesseract.tesseract_cmd = candidate
            break

    tessdata_dir = Path(__file__).with_name("tessdata")
    if tessdata_dir.exists():
        os.environ["TESSDATA_PREFIX"] = str(tessdata_dir)

    try:
        pytesseract.get_tesseract_version()
    except Exception as error:
        raise RuntimeError(
            "Tesseract OCR is not available. Install Tesseract and the Korean/English language data, "
            "or set TESSERACT_CMD to the tesseract executable path."
        ) from error


def load_images(image_path: Path) -> list[np.ndarray]:
    suffix = image_path.suffix.lower()
    if suffix == ".pdf":
        return load_pdf_pages(image_path)

    image = load_single_image(image_path)
    return [image] if image is not None else []


def load_single_image(image_path: Path) -> np.ndarray | None:
    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is not None:
        return image

    suffix = image_path.suffix.lower()
    if suffix not in {".heic", ".heif"}:
        return None

    if register_heif_opener is None:
        raise RuntimeError("HEIC support is not installed. Install pillow-heif.")

    register_heif_opener()

    with Image.open(image_path) as heic_image:
        rgb_image = heic_image.convert("RGB")
        image_array = np.array(rgb_image)

    return cv2.cvtColor(image_array, cv2.COLOR_RGB2BGR)


def load_pdf_pages(pdf_path: Path) -> list[np.ndarray]:
    try:
        document = pdfium.PdfDocument(str(pdf_path))
    except Exception as error:
        raise RuntimeError(
            "PDF rendering failed. Check that pypdfium2 is installed correctly and the uploaded PDF is readable."
        ) from error
    images: list[np.ndarray] = []

    try:
        for page_index in range(len(document)):
            page = document[page_index]
            bitmap = page.render(scale=2.2)
            pil_image = bitmap.to_pil().convert("RGB")
            image_array = np.array(pil_image)
            images.append(cv2.cvtColor(image_array, cv2.COLOR_RGB2BGR))
    finally:
        document.close()

    return images


def run_ocr_for_images(images: list[np.ndarray]) -> tuple[list[dict], list[str]]:
    all_rows: list[dict] = []
    warnings: list[str] = []

    for page_index, image in enumerate(images, start=1):
        corrected = deskew_document(image)
        page_rows, page_warnings = best_ocr_result(corrected)
        all_rows.extend(page_rows)
        warnings.extend(
            [f"{page_index}페이지: {warning}" for warning in page_warnings]
            if len(images) > 1
            else page_warnings
        )

    merged_rows = reindex_rows(merge_rows_by_barcode(all_rows))
    return merged_rows, dedupe_warnings(warnings)


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
    variants = build_ocr_variants(image)

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


def build_ocr_variants(image: np.ndarray) -> list[tuple[str, np.ndarray]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    variants: list[tuple[str, np.ndarray]] = [
        ("base", image),
        ("rot_cw", cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)),
        ("rot_ccw", cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)),
        ("rot_180", cv2.rotate(image, cv2.ROTATE_180)),
        ("gray", cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)),
    ]

    for variant_name, variant_image in list(variants[:4]):
        focused = build_column_focus_variants(variant_image)
        for focus_name, focus_image in focused:
            variants.append((f"{variant_name}_{focus_name}", focus_image))

    return variants


def build_column_focus_variants(image: np.ndarray) -> list[tuple[str, np.ndarray]]:
    content = crop_to_content_bounds(image)
    variants: list[tuple[str, np.ndarray]] = []
    sources = [("content", content)] if content is not None else []
    if content is None:
        sources.append(("full", image))

    for source_name, source_image in sources:
        height, width = source_image.shape[:2]
        if width < 200 or height < 200:
            continue

        for ratio in (0.52, 0.62, 0.72):
            crop_width = int(width * ratio)
            if crop_width < 160:
                continue

            crop = source_image[:, :crop_width]
            variants.append((f"{source_name}_left_{int(ratio * 100)}", upscale_for_ocr(crop)))

        mid_start = int(width * 0.06)
        mid_end = int(width * 0.72)
        if mid_end - mid_start >= 160:
            mid_crop = source_image[:, mid_start:mid_end]
            variants.append((f"{source_name}_mid", upscale_for_ocr(mid_crop)))

    return variants


def crop_to_content_bounds(image: np.ndarray) -> np.ndarray | None:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    threshold = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        11,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    merged = cv2.dilate(threshold, kernel, iterations=2)
    points = cv2.findNonZero(merged)
    if points is None:
        return None

    x, y, w, h = cv2.boundingRect(points)
    image_height, image_width = image.shape[:2]
    if w < image_width * 0.18 or h < image_height * 0.18:
        return None

    pad_x = max(16, int(w * 0.06))
    pad_y = max(16, int(h * 0.06))
    left = max(0, x - pad_x)
    top = max(0, y - pad_y)
    right = min(image_width, x + w + pad_x)
    bottom = min(image_height, y + h + pad_y)
    return image[top:bottom, left:right]


def upscale_for_ocr(image: np.ndarray, target_width: int = 1600) -> np.ndarray:
    height, width = image.shape[:2]
    if width >= target_width:
        return image

    scale = target_width / float(width)
    return cv2.resize(image, (target_width, int(height * scale)), interpolation=cv2.INTER_CUBIC)


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


def dedupe_warnings(warnings: list[str]) -> list[str]:
    return list(dict.fromkeys(warnings))


def format_runtime_error(error: Exception) -> str:
    message = str(error).strip()
    if not message:
        message = error.__class__.__name__
    return message


if __name__ == "__main__":
    raise SystemExit(main())
