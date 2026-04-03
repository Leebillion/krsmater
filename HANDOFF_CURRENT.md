# KRS Master Handoff

## Current Summary
KRS Master currently includes:

- shared server-side master sync with Express + SQLite
- local browser cache restore on startup
- scanner / search / bundle / convert / upload navigation
- bundle reporting, bundle report status management, and bundle master lookup
- excel/csv barcode conversion list from `상품코드` / `상품명`
- live QR/barcode scanner status overlay and result feedback
- installable PWA shell with manifest and service worker registration
- update-ready banner and local draft restore for safer refreshes

## Current Working Areas

### 1. Product Master
- active master upload, full sync, search, and matching APIs are in place
- app restores local IndexedDB data first, then syncs newer server master automatically
- local cache is still used for fast startup and offline-tolerant behavior

### 2. Scanner
- scanner button labels are `카메라 활성화`, `카메라 끄기`, `재스캔`
- while the camera is actively reading, the preview shows `스캔중`
- after a successful read, the preview briefly shows `스캔성공`
- both native `BarcodeDetector` and ZXing fallback paths update the same scan feedback state
- camera startup prefers rear camera, high resolution, and continuous focus hints
- once enabled, scanner auto-reactivation is attempted on the next visit

### 3. PWA
- Vite PWA plugin is configured
- manifest and service worker are generated at build time
- home screen installation is available with standalone launch
- static assets are cached for faster revisit and more stable shell loading
- when a new deployed version is ready, the app shows an update banner
- search/scanner input and bundle forms are stored as local draft state and restored after refresh

### 4. Bundle Menu
Bundle menu tabs are currently:

- `번들 제보`
- `번들 제보 상황`
- `번들 검색`

Implemented behavior:

- bundle report save to SQLite
- bundle report DB Excel download
- bundle report status list / edit / delete
- bundle master Excel upload
- bundle master search by product name or barcode

### 5. Bundle Input / Validation
- bundle report field limits are enforced at input time
- barcode fields allow `1~13` digits, including leading `0`
- name fields are limited to `30byte`
- quantity is limited to `2` digits

### 6. Bundle Master Upload Rules
Current upload behavior:

- first row is treated as header
- empty rows are skipped with warning messages
- duplicate bundle barcode warns and keeps the later row
- duplicate item barcode warns and continues
- bundle master search does not support full-list load by default; a search term is required

Accepted headers include practical variants such as:

- `번들바코드`
- `번들 바코드`
- `번들상품명`
- `입수`
- `상품코드`
- `낱개바코드`
- `낱개 바코드`
- `상품명`

## Recent Fixes

### Convert Menu
- added a new main menu tab `변환`
- `변환` accepts `.xlsx`, `.xls`, `.csv`
- expected headers are `상품코드`, `상품명`
- converted output renders as `바코드`, `상품명` cards with visible barcode previews
- rows missing either code or name are skipped with warning messages

### Scanner UX
- changed scanner CTA text from `카메라 켜기` to `카메라 활성화`
- changed scanner reset text from `초기화` to `재스캔`
- added preview overlay feedback for `스캔중` and `스캔성공`
- added focus-related camera constraints to improve Android device behavior, including Galaxy S25 reports
- persisted scanner preference so the next visit auto-attempts camera activation

### Current Request Follow-up
- scanner panel now stays fixed below the top header while scrolling through match results
- product/barcode search now runs with an explicit `검색` button or Enter key
- numeric search requires at least `4` digits
- Korean/English text search requires at least `6byte`

### Latest UI Adjustments
- scanner panel sticky behavior was removed again so the scan area scrolls naturally with results
- scanner now auto-attempts camera activation when the app opens
- scanner status and last scan text were merged into a smaller summary card to save mobile space
- direct manual correction input was removed from the scanner panel to prioritize result visibility

### PWA
- added installable app manifest
- added service worker registration for production builds
- added app icons including Apple touch icon
- added update-ready banner so users can apply a new deployed version intentionally
- persisted in-progress UI drafts to reduce form loss during refresh/update

### Bundle Report Status
- added `GET /api/bundles/report`
- added `PUT /api/bundles/report/:id`
- added `DELETE /api/bundles/report/:id`
- bundle report status tab now loads saved reports and supports inline correction

### Runtime Issue Found And Fixed
Observed issue:

- bundle report status screen showed a load failure even though saves succeeded

Root cause:

- local API server process was still running an older build that did not expose `GET /api/bundles/report`

Fix:

- restarted server with latest code
- verified `GET /api/bundles/report` returns saved rows

### Korea Time Save
- new bundle report saves now store `createdAt` as KST offset format such as `+09:00`
- older rows may still remain in previous UTC format

## Main Files Updated In This Phase
- `src/KrsMasterApp.tsx`
- `src/lib/converter.ts`
- `src/main.tsx`
- `src/lib/api.ts`
- `src/components/BarcodePreview.tsx`
- `src/components/Icons.tsx`
- `server/index.js`
- `server/db.js`
- `package.json`
- `package-lock.json`

## Local Verification
Confirmed locally:

- `npm run lint`
- `npm run build`
- `node --check server/index.js`
- `node --check server/db.js`
- `GET /api/bundles/report`
- `POST /api/bundles/report`

## Current Data / Runtime Notes
- SQLite DB path: `data/krsmaster.sqlite`
- `data/` stays untracked
- local API must be restarted after backend route changes
- some PowerShell output may still look mojibake when printing Korean JSON directly, even if browser/app behavior is fine

## Recommended Next Checks
1. verify scanner focus/read speed on actual Galaxy S25 hardware
2. verify iPhone Safari/Chrome behavior under valid HTTPS
3. verify PWA install flow on Android and iPhone
4. verify update banner and draft restore behavior after a new deploy
5. normalize display of old UTC-saved bundle report times if needed
6. consider search/filter inside `번들 제보 상황` when report count grows
7. clean remaining mojibake strings in source and docs when convenient

## Useful Commands

```bash
npm run lint
npm run build
npm run server
```

Quick API checks:

```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/bundles/report
```

## Latest Update Note 3
- photo OCR input now exposes both `카메라 촬영` and `기존 사진 선택`
- server OCR python command resolution was split into `server/pythonResolver.js`
- local or deployed server startup can use `PYTHON_EXECUTABLE` when Python is not discoverable on PATH
- added root `requirements.txt` for Ubuntu OCR dependency setup
- `server/ocr_inventory_table.py` now supports `.heic` / `.heif` image loading through a Pillow fallback path
- Ubuntu servers still need system packages such as `tesseract-ocr`, `tesseract-ocr-kor`, `tesseract-ocr-eng`, `libgl1`, and `libglib2.0-0`

## Latest Update Note
- convert tab is now active in the main menu as `변환`
- accepted input files: `.xlsx`, `.xls`, `.csv`
- expected input headers: `상품코드`, `상품명`
- output cards render `바코드`, `상품명`, and a visible barcode preview
- Excel numeric barcode cells are converted without scientific notation where possible
- visible row labels in convert cards now exclude the header row
- if the original Excel file already lost leading `0` because the code column was saved as numeric, recovery is not possible in-app
- recommended operator rule: keep the `상품코드` column as text format when leading `0` matters

## Latest Update Note 2
- search tab now supports Korean initial-consonant search and combined token search
- supported examples include `ㅅㅋ ㄸㄱ` and `새콤 딸기`
- convert tab now includes `재고현황 표 사진 변환`
- photo OCR flow supports mobile camera upload, document correction, Korean OCR, editable result rows, and xlsx export
- sample inventory photo extraction improved from 12 rows to 14 rows in local verification
- each OCR row now shows `상품코드`, `마스터 일치 여부`, `상품명`, `생성 바코드`
- OCR result rows can be temporarily saved per device in IndexedDB and restored on the next visit
- additional photo captures append below existing OCR rows instead of replacing them
- OCR result actions now include total count, temporary save, delete, and excel download
- barcode preview is intended for follow-up smartphone scanning and quantity entry workflow
- server-side OCR currently uses Python + OpenCV + pytesseract with local `server/tessdata`
