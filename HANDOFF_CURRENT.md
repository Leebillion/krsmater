# KRS Master Handoff

## Current Summary
KRS Master currently includes:

- Express + SQLite based shared master sync
- browser IndexedDB cache restore on startup
- scanner / search / bundle / convert / upload navigation
- bundle report save, edit, delete, and Excel export
- bundle master lookup
- bundle master upload from the upload menu
- Excel/CSV barcode conversion
- photo/PDF OCR conversion flow
- installable PWA shell with update banner and local draft restore

## Current Working Areas

### 1. Product Master
- active master upload, full sync, search, and matching APIs are in place
- app restores local IndexedDB data first, then syncs newer server master automatically
- local cache is still used for fast startup and offline-tolerant behavior
- upload filename is now normalized server-side to reduce Korean filename mojibake
- rows without `shortName` are now treated as valid rows, not irregular rows

### 2. Search / Match Result
- barcode search supports exact match and similar match ranking
- text search supports product name and short name matching
- records with empty `shortName` are now treated as bundle-style products for display only
- bundle-style match cards now show an orange card background and a `번들` badge

### 3. Upload Menu Layout
- `현재 마스터`, `번들 마스터`, `변환 현황`, and `최근 업로드` cards are shown only in the `업로드` menu
- bundle master upload was moved out of `번들 > 번들 검색`
- bundle master upload is now triggered from the `업로드` menu's `번들 마스터` card

### 4. Scanner
- scanner button labels are `카메라 활성화`, `카메라 끄기`, `재스캔`
- while the camera is actively reading, the preview shows `스캔중`
- after a successful read, the preview briefly shows `스캔성공`
- both native `BarcodeDetector` and ZXing fallback paths update the same scan feedback state
- camera startup prefers rear camera, high resolution, and continuous focus hints
- once enabled, scanner auto-reactivation is attempted on the next visit

### 5. Convert Menu
- convert tab accepts `.xlsx`, `.xls`, `.csv`
- expected headers are `상품코드`, `상품명`
- converted output renders barcode cards with preview
- rows missing either code or name are skipped with warning messages
- converted results can now be saved to server SQLite with an operator-defined name
- saved convert results can be listed, reloaded, and deleted on later visits

### 6. Photo OCR Convert
- photo OCR accepts mobile camera captures, gallery images, and scanned PDFs
- OCR rows remain editable in the browser
- OCR rows can still be temporarily saved per device in IndexedDB
- OCR rows can now also be stored in server SQLite as named saved sets
- server upload filename normalization also applies to OCR image/PDF filenames

### 7. Bundle Menu
Bundle menu tabs are currently:

- `번들 제보`
- `번들 제보 상황`
- `번들 검색`

Implemented behavior:

- bundle report save to SQLite
- bundle report DB Excel download
- bundle report status list / edit / delete
- bundle master search by product name or barcode

## Main Backend Additions In This Phase
- filename normalization helper for multipart uploads
- convert saved-set tables:
  - `convert_saved_sets`
  - `convert_saved_rows`
- convert saved-set APIs:
  - `GET /api/convert/saved`
  - `GET /api/convert/saved/:id`
  - `POST /api/convert/saved`
  - `DELETE /api/convert/saved/:id`
- duplicate convert save names now return HTTP `409`
- master parser now counts `barcode + name` rows as valid even when `shortName` is missing

## Main Files Updated In This Phase
- `src/KrsMasterApp.tsx`
- `src/lib/api.ts`
- `src/lib/converter.ts`
- `src/lib/master.ts`
- `server/index.js`
- `server/db.js`
- `server/masterParser.js`

## Local Verification
Confirmed locally:

- `npm run lint`
- `npm run build`
- `node --check server/index.js`
- `node --check server/db.js`
- `node --check server/masterParser.js`

## Current Data / Runtime Notes
- SQLite DB path: `data/krsmaster.sqlite`
- `data/` stays untracked
- local API must be restarted after backend route changes
- existing DB will create convert save tables automatically on next server start
- some PowerShell output may still look mojibake when printing Korean JSON directly, even if browser/app behavior is fine

## Recommended Next Checks
1. verify actual Korean filename uploads from Windows/iPhone browsers across all upload panels
2. verify saved convert result load/delete behavior with real operator data volumes
3. verify the upload menu layout is clearer for operators after moving bundle master upload
4. verify rows without short names no longer inflate `예외 행`
5. verify photo OCR named saves do not confuse users versus local temporary save
6. verify scanner focus/read speed on actual Galaxy S25 hardware
7. verify iPhone Safari/Chrome behavior under valid HTTPS
8. verify PWA install flow and update banner behavior after a new deploy
9. continue cleaning remaining mojibake strings in source and docs when convenient

## Useful Commands

```bash
npm run lint
npm run build
npm run server
```

Quick API checks:

```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/convert/saved
curl http://localhost:3100/api/bundles/report
```
