# KRS Master Next Tasks

## Current Requested Priorities

### 1. Verify scanner behavior on real devices
Goal:
- Android, iPhone, and desktop browsers should all have a stable scan path.

Focus points:
- HTTPS and valid certificate
- camera permission flow
- iPhone fallback scanner path
- Galaxy S25 focus / near-distance readability

### 2. Clean remaining Korean text / encoding issues
Goal:
- remove remaining mojibake from source and docs so maintenance is safer

Focus points:
- old labels/messages still stored in source files
- docs that were written before UTF-8 cleanup
- any filename/path displays that still regress on specific browsers

### 3. Validate named convert-result save/load flow
Goal:
- confirm server-saved convert datasets are stable in real operations

Focus points:
- duplicate save-name handling
- save/load/delete behavior across multiple devices
- OCR saved sets versus local temporary save clarity
- larger row-count performance

## Highest Priority

### 1. Fix iPhone scanner in real deployment
Reason:
- iPhone camera access needs HTTPS
- even with fallback scanning, invalid certs or insecure context will still block camera access

Actions:
- apply valid SSL certificate on nginx
- force redirect `http -> https`
- verify certificate trust on iPhone Safari and Chrome
- retest scanner on actual iPhone device

Expected result:
- `navigator.mediaDevices.getUserMedia` works on iPhone
- scanner no longer fails due to insecure context

### 2. Re-check ZXing fallback on iPhone
Reason:
- native `BarcodeDetector` is not generally available on iPhone browsers
- fallback path is the main mobile path on iOS

Actions:
- test camera startup on iPhone Chrome and Safari
- verify QR read speed and barcode read speed
- verify rear camera selection behavior
- confirm cleanup when leaving scanner screen

Expected result:
- scanner works without native `BarcodeDetector`

### 3. Validate Galaxy S25 focus improvements
Reason:
- a field report says focus is not locking well on Galaxy S25
- current build now requests rear camera, high resolution, and continuous focus hints, but device support can vary

Actions:
- test QR and barcode reads at close and medium distance
- check whether preview sharpness improves after a short settle time
- if still weak, consider tap-to-focus attempt or torch toggle

Expected result:
- scanner reaches readable focus faster on Galaxy S25

## High Priority

### 4. Validate convert saved-set operations with real data
Reason:
- named server-side saves were just added
- operational safety matters more than local happy-path validation

Actions:
- save normal convert results with real `.xlsx` and `.csv` inputs
- save OCR results after edit, reload them, and confirm row fidelity
- verify duplicate save names return clear UI errors
- test deleting saved sets and reloading the list

Expected result:
- operators can reliably reuse saved convert results across visits and devices

### 5. Clean mojibake in source and docs
Reason:
- several strings in code and markdown still show encoding damage
- this creates maintenance and QA risk

Actions:
- normalize files to UTF-8
- replace broken Korean text with clean Korean labels/messages
- verify UI labels after build

Expected result:
- source and docs are readable
- labels are stable and maintainable

### 6. Improve upload error reporting
Reason:
- current failures can still look similar to end users
- easier debugging is needed for operations

Actions:
- distinguish parsing failure vs IndexedDB failure vs browser API failure
- show row count / exception row count in success state
- show explicit secure-context warning for scanner

Expected result:
- user and operator can quickly identify why upload failed

## Medium Priority

### 7. Validate convert-tab real files
Reason:
- convert tab assumes headers `상품코드`, `상품명`
- Excel source files may still contain numeric cells, spaces, or leading-zero edge cases

Actions:
- test with real `.xlsx` and `.csv` samples
- verify leading `0` preservation from source files
- decide whether alias headers or export/download output is also needed

Expected result:
- conversion works reliably with real operator files

### 8. Expand parser for real-world file variants
Reason:
- field assumptions may differ by actual source files
- `.dat`, `.mst`, `.csv` are selectable but parser is still fixed-width oriented first

Actions:
- inspect real samples for each extension
- branch parser by format when needed
- support delimiter-based CSV if used in practice
- handle BOM/header lines if present

Expected result:
- import succeeds for actual production file variants

### 9. Decide whether tap-to-focus or torch UI is needed
Reason:
- some Android devices may still need extra camera assistance beyond current constraints

Actions:
- test whether `applyConstraints` focus hints are honored on target browsers
- if needed, add tap-to-focus attempt on preview touch
- if useful, add flashlight toggle where supported

Expected result:
- more reliable scanning on difficult mobile hardware

### 10. Harden PWA update UX
Reason:
- service worker caching is now enabled
- update and cache invalidation behavior should be verified in production

Actions:
- confirm a new deploy updates the installed app correctly
- review whether current update banner timing/message needs refinement
- verify offline fallback expectations with real usage
- verify draft restore does not revive stale values after successful save

Expected result:
- installed app updates predictably without confusing stale UI

## Deployment Checklist

Before next release:

1. `npm install`
2. `npm run lint`
3. `npm run build`
4. restart backend so new SQLite tables/routes are active
5. deploy `dist/`
6. verify HTTPS
7. test upload with real production master file
8. test search and bundle-card highlighting
9. test barcode rendering
10. test scanner on Android Chrome
11. test scanner on iPhone Safari/Chrome
12. test scanner on Galaxy S25
13. test saved convert result flow on at least two devices
14. test installed PWA launch and update flow

## Notes For Next Person
- shared master sync already exists with Express + SQLite
- local IndexedDB is now cache/restore oriented, not the only persistence layer
- current scanner logic is in `src/KrsMasterApp.tsx`
- parser/matching logic is in `src/lib/master.ts`
- server convert-save storage is in `server/db.js`
- current convert save naming is globally unique across all saved sets
- real blocking issue for iPhone is still HTTPS/certificate first, scanner fallback second
