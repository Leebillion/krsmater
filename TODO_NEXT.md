# KRS Master Next Tasks

## Current Requested Priorities

### 1. Move master storage to shared DB
Goal:
- Once a master file is uploaded, all devices should be able to search the same dataset.

Target direction:
- Upload on server
- Parse on server
- Store master rows in DB
- Search/match through shared API
- Keep IndexedDB only as optional cache

### 2. Make camera usable on all devices
Goal:
- Android, iPhone, desktop browsers should all have a working scan path.

Blocking conditions:
- HTTPS
- valid certificate
- camera permission
- iOS fallback scanner path

### 3. Convert to PWA
Goal:
- Installable web app
- better field usability
- offline-friendly shell and cache

## Highest Priority

### 1. Fix iPhone scanner in real deployment
Reason:
- iPhone camera access needs HTTPS
- current service appears to be accessed in a non-secure or certificate-warning context

Actions:
- apply valid SSL certificate on nginx
- force redirect `http -> https`
- verify certificate trust on iPhone Safari/Chrome
- retest scanner on actual iPhone device

Expected result:
- `navigator.mediaDevices.getUserMedia` works on iPhone
- scanner no longer fails due to insecure context

### 2. Re-check ZXing fallback on iPhone
Reason:
- native `BarcodeDetector` is not generally available on iPhone browsers
- fallback path must be the main mobile path on iOS

Actions:
- test camera startup on iPhone Chrome and Safari
- verify QR read speed and barcode read speed
- verify camera switching / rear camera selection behavior
- confirm cleanup when leaving scanner screen

Expected result:
- scanner works without native `BarcodeDetector`

## High Priority

### 3. Clean broken Korean text / encoding issues in source
Reason:
- several UI strings in `src/App.tsx` and `src/lib/master.ts` appear corrupted locally
- this can create future maintenance risk

Actions:
- normalize files to UTF-8
- replace broken Korean strings with clean Korean text
- verify UI labels after build

Expected result:
- source code is readable
- labels are stable and maintainable

### 4. Improve upload error reporting
Reason:
- current failures can look similar to end users
- easier debugging is needed for operations

Actions:
- distinguish parsing failure vs IndexedDB failure vs browser API failure
- show row count / exception row count in success state
- show explicit secure-context warning for scanner

Expected result:
- user and operator can quickly identify why upload failed

## Medium Priority

### 5. Expand parser for real-world file variants
Reason:
- field assumptions may differ by actual source files
- `.dat`, `.mst`, `.csv` are now selectable but parser is still fixed-width oriented

Actions:
- inspect real samples for each extension
- branch parser by format when needed
- support delimiter-based CSV if used in practice
- handle BOM/header lines if present

Expected result:
- import succeeds for actual production file variants

### 6. Add backend sync strategy
Reason:
- IndexedDB is only local to one browser/device
- operations may require a shared latest master

Actions:
- implement server-side upload and parsing
- store current active master in DB
- keep IndexedDB as local cache only
- add master version metadata API
- sync latest master from server on app startup

Expected result:
- shared master across devices
- still fast local search/scanning

## Deployment Checklist

Before next release:

1. `npm install`
2. `npm run lint`
3. `npm run build`
4. deploy `dist/`
5. verify HTTPS
6. test upload with real production master file
7. test search
8. test barcode rendering
9. test scanner on Android Chrome
10. test scanner on iPhone Safari/Chrome

## Notes For Next Person
- Current persistence is IndexedDB only.
- Current scanner logic is in `src/App.tsx`.
- Current parser logic is in `src/lib/master.ts`.
- Current service name is `KRS Master`.
- Real blocking issue for iPhone is likely HTTPS/certificate first, scanner fallback second.
