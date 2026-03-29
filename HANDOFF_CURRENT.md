# KRS Master Handoff

## Current Summary
KRS Master currently includes:

- shared server-side master sync with Express + SQLite
- local browser cache restore on startup
- scanner / search / bundle / upload navigation
- bundle reporting, bundle report status management, and bundle master lookup
- live QR/barcode scanner status overlay and result feedback

## Current Working Areas

### 1. Product Master
- active master upload, full sync, search, and matching APIs are in place
- app restores local IndexedDB data first, then syncs newer server master automatically
- local cache is still used for fast startup and offline-tolerant behavior

### 2. Scanner
- scanner button labels are now `카메라 활성화`, `카메라 끄기`, and `재스캔`
- while the camera is actively reading, the preview shows `스캔중`
- after a successful read, the preview briefly shows `스캔성공`
- both native `BarcodeDetector` and ZXing fallback paths update the same scan feedback state
- camera startup now prefers rear camera, high resolution, and continuous focus hints

### 3. Bundle Menu
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

### 4. Bundle Input / Validation
- bundle report field limits are enforced at input time
- barcode fields allow `1~13` digits, including leading `0`
- name fields are limited to `30byte`
- quantity is limited to `2` digits

### 5. Bundle Master Upload Rules
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

### Scanner UX
- changed scanner CTA text from `카메라 켜기` to `카메라 활성화`
- changed scanner reset text from `초기화` to `재스캔`
- added preview overlay feedback for `스캔중` and `스캔성공`
- added focus-related camera constraints to improve Android device behavior, including Galaxy S25 reports

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
- `src/lib/api.ts`
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
3. normalize display of old UTC-saved bundle report times if needed
4. consider search/filter inside `번들 제보 상황` when report count grows
5. clean remaining mojibake strings in source and docs when convenient

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
