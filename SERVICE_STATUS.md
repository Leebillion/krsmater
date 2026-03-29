# KRS Master Service Status

## Overview
KRS Master is a web app for importing a product master file, syncing the active master through the server, searching products, scanning QR/barcodes, and matching scanned values to existing master barcodes even when they are not perfectly identical.

## Current User Flow
1. User opens the web app.
2. App restores the last cached master from IndexedDB if available.
3. App checks the server for a newer active master.
4. User uploads a master file when needed.
5. App parses the file client-side and uploads the active copy to the server.
6. User can search by barcode, product name, or short name.
7. User can open the scanner screen and scan QR/barcodes.
8. App shows exact matches first, then similar barcode candidates.
9. Each result card also renders a barcode that can be scanned by another scanner.

## Current Data Model
Master file is treated as a fixed-width text file.

- Barcode: 13 bytes
- Product name: 30 bytes
- Short name: 14 bytes
- Total expected row width: 57 bytes
- Encoding assumption: CP949 / EUC-KR family

The parser currently tolerates irregular-width rows and counts them as exceptions.

## Current Architecture

Main files:

- `src/KrsMasterApp.tsx`
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
- local restore and server sync coordination

### `src/lib/master.ts`
- master file parsing
- similar barcode matching logic
- similarity scoring

### `src/lib/persistence.ts`
- IndexedDB open/load/save/delete helpers
- stores cached records, summary, and upload history in browser storage

### `src/lib/api.ts`
- client API wrappers for master sync and bundle features

### `server/index.js` / `server/db.js`
- active master storage
- bundle report CRUD
- bundle master upload/search
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

## Current Persistence Behavior
After import:

- parsed records are stored in IndexedDB as local cache
- summary is stored in IndexedDB
- upload history is stored in IndexedDB
- active master is uploaded to the server

After reload:

- app hydrates from IndexedDB
- app checks for a newer active server master
- newer server data replaces stale local cache

## Current Scanner Behavior
Two scanner paths exist:

1. Native `BarcodeDetector`
2. Fallback scanner using `@zxing/browser`

Current behavior:

- rear camera is preferred
- high-resolution and continuous-focus hints are requested where supported
- camera preview shows `스캔중` while reading
- successful reads briefly show `스캔성공`
- if browser is not in a secure context, an explanatory error is shown

## Important Operational Note
iPhone camera scanning still requires HTTPS.

Even with fallback scanning, `navigator.mediaDevices.getUserMedia` can be blocked when the service is opened over HTTP or when the certificate is invalid.

## Current Known Constraints
- tap-to-focus is not implemented yet
- mobile browsers may ignore some focus constraints even when requested
- some source/docs still contain mojibake from past encoding mismatch
- iPhone scanning still depends on secure context and camera permission

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
- barcode preview rendering
- scanner status overlay
- fallback ID generation when `crypto.randomUUID()` is unavailable
- broader upload file chooser extensions: `.txt`, `.dat`, `.mst`, `.csv`
- bundle report save / edit / delete
- bundle master upload / lookup
