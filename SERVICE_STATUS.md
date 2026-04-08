# KRS Master Service Status

## Overview
KRS Master is a web app for importing a product master file, syncing the active master through the server, searching products, scanning QR/barcodes, and matching scanned values to existing master barcodes even when they are not perfectly identical.

It also supports PWA installation with standalone launch behavior, bundle workflows, barcode conversion, and photo/PDF OCR conversion.

## Current User Flow
1. User opens the web app.
2. App restores the last cached master from IndexedDB if available.
3. App checks the server for a newer active master.
4. User uploads a master file when needed.
5. App parses the file client-side and uploads the active copy to the server.
6. User can search by barcode, product name, or short name.
7. User can open the scanner screen and scan QR/barcodes.
8. App shows exact matches first, then similar barcode candidates.
9. Match cards with empty `shortName` are highlighted as bundle-style products.
10. User can convert Excel/CSV input into barcode result cards.
11. User can convert photo/PDF inventory sheets through OCR.
12. User can temporarily save OCR rows on-device or save convert/OCR results to server DB with a custom name.
13. Upload-related status cards are shown in the `업로드` menu, and bundle master upload is triggered there.
14. Installed users can relaunch the app from the home screen.
15. If a new deployed version is ready, the app shows an update banner before refresh.

## Current Data Model
Master file is treated as a fixed-width text file.

- Barcode: 13 bytes
- Product name: 30 bytes
- Short name: 14 bytes
- Total expected row width: 57 bytes
- Encoding assumption: CP949 / EUC-KR family

The parser currently tolerates irregular-width rows and counts them as exceptions.
Rows that stop after `barcode + name` are now also treated as valid rows, so missing `shortName` does not increase `irregularRows`.

## Current Architecture

Main files:

- `src/KrsMasterApp.tsx`
- `src/main.tsx`
- `src/lib/master.ts`
- `src/lib/persistence.ts`
- `src/lib/api.ts`
- `server/index.js`
- `server/db.js`

### `src/KrsMasterApp.tsx`
- main app shell and view switching
- upload flow
- search flow
- scanner flow
- convert and OCR result rendering
- upload-menu-only status card layout
- bundle master upload entry point in the upload menu
- local restore and server sync coordination
- scanner preference persistence
- local draft persistence for in-progress form/input values
- server-side convert save/load/delete UI
- update/offline readiness banners

### `src/main.tsx` / `vite.config.ts`
- service worker registration
- manifest generation
- installable PWA configuration
- update-ready and offline-ready event bridging

### `src/lib/master.ts`
- master file parsing
- similar barcode matching logic
- similarity scoring
- shortName-missing rows are treated as valid rows for summary counting

### `src/lib/persistence.ts`
- IndexedDB open/load/save/delete helpers
- stores cached records, summary, and upload history in browser storage
- stores temporary photo OCR rows per device

### `src/lib/api.ts`
- client API wrappers for master sync
- bundle CRUD APIs
- OCR upload API
- convert saved-set APIs

### `server/index.js` / `server/db.js`
- active master storage
- bundle report CRUD
- bundle master upload/search
- convert saved-set CRUD
- Korean filename normalization for multipart uploads
- SQLite persistence

## Current Matching Logic
Search/scanner values are normalized and compared against stored master records.

Matching includes:

- exact barcode match
- edit-distance based similarity
- common prefix similarity
- common suffix similarity
- partial containment
- product name / short name text match

Top candidates are sorted by score and only a limited number are shown.

Display-only bundle highlighting:

- if `shortName` is empty, the card is treated as bundle-style
- bundle-style cards use an orange tone
- bundle-style cards show a `번들` badge

## Current Persistence Behavior
After import:

- parsed records are stored in IndexedDB as local cache
- summary is stored in IndexedDB
- upload history is stored in IndexedDB
- active master is uploaded to the server

During normal use:

- search/scanner input is stored locally as draft state
- bundle report form and editing form are stored locally as draft state
- draft state is restored after refresh or update
- photo OCR rows can be temporarily saved in IndexedDB
- convert results and photo OCR result sets can be saved in server SQLite with an operator-defined name

After reload:

- app hydrates from IndexedDB
- app checks for a newer active server master
- newer server data replaces stale local cache
- saved convert result sets remain available from the server across devices

## Current Upload Menu Layout
- `현재 마스터`, `번들 마스터`, `변환 현황`, and `최근 업로드` cards are shown only in the `업로드` menu
- bundle master upload is initiated from the `번들 마스터` card in the upload menu
- `번들 > 번들 검색` now focuses on lookup only

## Current Scanner Behavior
Two scanner paths exist:

1. Native `BarcodeDetector`
2. Fallback scanner using `@zxing/browser`

Current behavior:

- rear camera is preferred
- high-resolution and continuous-focus hints are requested where supported
- camera preview shows `스캔중` while reading
- successful reads briefly show `스캔성공`
- if scanner was previously enabled, the next visit auto-attempts camera activation
- if browser is not in a secure context, an explanatory error is shown

## Current Upload Filename Handling
- multipart upload filenames are normalized server-side before they are stored or returned in summaries
- intended goal is to reduce Korean filename mojibake from browser/server encoding mismatch
- current normalization prefers the original filename unless `latin1 -> utf8` recovery is clearly more readable

## Current Saved Convert Result Behavior
- saved result tables:
  - `convert_saved_sets`
  - `convert_saved_rows`
- supported sources:
  - `file`
  - `photo`
- save names are globally unique
- APIs:
  - `GET /api/convert/saved`
  - `GET /api/convert/saved/:id`
  - `POST /api/convert/saved`
  - `DELETE /api/convert/saved/:id`
- duplicate save names return `409`

## Current PWA Behavior
- build generates a web app manifest and service worker
- app can be installed from supported browsers
- launch mode is `standalone`
- static shell assets are cached for quicker revisit
- app shows an update banner when a newer deployed version is ready
- app shows an offline-ready banner after PWA caching is prepared
- search/scanner input and bundle form drafts are restored after refresh

## Important Operational Note
iPhone camera scanning still requires HTTPS.

Even with fallback scanning, `navigator.mediaDevices.getUserMedia` can be blocked when the service is opened over HTTP or when the certificate is invalid.

## Current Known Constraints
- tap-to-focus is not implemented yet
- mobile browsers may ignore some focus constraints even when requested
- some source/docs still contain mojibake from past encoding mismatch
- iPhone scanning still depends on secure context and camera permission
- installed app update behavior should be verified on real deployments
- real-world validation is still needed for larger saved convert result sets

## Current Nginx/Deployment Assumption
The service is deployed behind nginx.

The app is built with Vite:

- dev: `npm run dev`
- prod build: `npm run build`

Production artifact:

- `dist/`

## Last Confirmed Functional Areas
- master upload
- server sync + local cache restore
- search result ranking
- bundle-style match-card highlighting
- barcode preview rendering
- scanner status overlay
- automatic scanner reactivation attempt on revisit
- broader upload file chooser extensions: `.txt`, `.dat`, `.mst`, `.csv`
- bundle report save / edit / delete
- bundle master lookup
- upload-menu bundle master upload
- installable PWA manifest and service worker
- update-ready banner
- local draft restore after refresh
- photo OCR temporary device save
- convert saved-set server save / load / delete
