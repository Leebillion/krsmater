# KRS Master Service Status

## Overview
KRS Master is a web app for importing a product master file, searching products, scanning QR/barcodes, and matching scanned values to existing master barcodes even when they are not perfectly identical.

## Current User Flow
1. User opens the web app.
2. App restores the last imported master from IndexedDB if available.
3. User uploads a master file.
4. App parses the file in the browser and stores the parsed result in IndexedDB.
5. User can search by barcode, product name, or short name.
6. User can open the scanner screen and scan QR/barcodes.
7. App shows exact matches first, then similar barcode candidates.
8. Each result card also renders a barcode that can be scanned by another scanner.

## Current Data Model
Master file is treated as a fixed-width text file.

- Barcode: 13 bytes
- Product name: 30 bytes
- Short name: 14 bytes
- Total expected row width: 57 bytes
- Encoding assumption: CP949 / EUC-KR family

The parser currently tolerates irregular-width rows and counts them as exceptions.

## Current Client-Side Architecture
Main files:

- `src/App.tsx`
- `src/lib/master.ts`
- `src/lib/persistence.ts`
- `src/components/BarcodePreview.tsx`

### `src/App.tsx`
- Main app shell and view switching
- Upload flow
- Search flow
- Scanner flow
- IndexedDB hydration and persistence

### `src/lib/master.ts`
- Master file parsing
- Similar barcode matching logic
- Similarity scoring

### `src/lib/persistence.ts`
- IndexedDB open/load/save/delete helpers
- Stores parsed records, summary, and upload history in browser storage

### `src/components/BarcodePreview.tsx`
- Generates visible barcodes for result cards
- Uses `EAN-13` for 13-digit numeric values
- Falls back to `CODE128` for supported general strings

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

- parsed records are stored in IndexedDB
- summary is stored in IndexedDB
- upload history is stored in IndexedDB

After reload:

- app hydrates from IndexedDB
- last master is restored automatically

## Current Scanner Behavior
Two scanner paths exist:

1. Native `BarcodeDetector`
2. Fallback scanner using `@zxing/browser`

Current intent:

- If browser supports `BarcodeDetector`, use native path.
- Otherwise try ZXing fallback path.
- If browser is not in a secure context, show an explanatory error.

## Important Operational Note
iPhone camera scanning requires HTTPS.

Even if the fallback scanner is implemented, `navigator.mediaDevices.getUserMedia` can still be blocked when the service is opened over HTTP or when the certificate is invalid.

## Current Known Constraints
- App is browser-local only for persistence. There is no central backend sync yet.
- Master parsing assumes CP949 fixed-width format first.
- Some source files currently contain mojibake/broken Korean text caused by encoding mismatch in local editing history.
- iPhone scanning still depends on secure context and camera permission.

## Current Nginx/Deployment Assumption
The service is being deployed behind nginx.

The app is built with Vite:

- dev: `npm run dev`
- prod build: `npm run build`

Production artifact:

- `dist/`

## Last Confirmed Functional Areas
- master upload
- IndexedDB persistence
- local restore after reload
- search result ranking
- barcode preview rendering
- fallback ID generation when `crypto.randomUUID()` is unavailable
- broader upload file chooser extensions: `.txt`, `.dat`, `.mst`, `.csv`

