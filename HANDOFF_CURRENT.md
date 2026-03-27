# KRS Master Handoff

## Current Summary
KRS Master is now in a partially production-ready state with:

- frontend app implemented in Vite + React
- local IndexedDB persistence
- shared server-side master storage foundation
- Express API server
- SQLite DB storage
- barcode rendering in search results
- QR/barcode scanner with native `BarcodeDetector` and ZXing fallback path

## Git Status
Latest confirmed pushed commit before any new uncommitted local changes:

- `e1f5d90`
- `Add shared master API and client sync foundation`

There are additional local modifications after that for better upload error handling:

- `src/lib/api.ts`
- `server/index.js`

These were validated locally with:

- `npm run lint`
- `npm run build`

## Important Current Operational Status
User reported:

- nginx upload size limit has been increased
- HTTPS has been applied on the server

This is important because:

- large master upload should now bypass previous `413 Request Entity Too Large`
- iPhone camera access should now be possible in secure context

## Confirmed Root Cause of Recent Upload Failure
Recent upload failure was not a parser failure.

Actual cause:

- nginx returned `413 Request Entity Too Large`

Evidence:

- browser devtools showed `413`
- tested master file size was about 6.14 MB
- Node `multer` limit is already set to 25 MB

Conclusion:

- request was blocked before reaching Express

## Current Code Structure

### Frontend
- `src/KrsMasterApp.tsx`
  New main app implementation
- `src/App.tsx`
  Re-export wrapper to `KrsMasterApp`
- `src/lib/master.ts`
  parsing + local similarity logic
- `src/lib/persistence.ts`
  IndexedDB storage
- `src/lib/api.ts`
  frontend API client for server sync
- `src/components/BarcodePreview.tsx`
  result barcode rendering

### Backend
- `server/index.js`
  Express API entry
- `server/db.js`
  SQLite access layer
- `server/masterParser.js`
  server-side master parser + matching helper

### Docs
- `SERVICE_STATUS.md`
- `TODO_NEXT.md`

## API Endpoints Currently Added
- `GET /api/health`
- `GET /api/master/status`
- `GET /api/master/full`
- `POST /api/master/import`
- `GET /api/search?q=...`
- `GET /api/match?code=...`

## Server/Data Notes
- SQLite DB path: `data/krsmaster.sqlite`
- `data/` is gitignored
- server creates DB automatically

## Verified Local End-to-End Result
Local API test with real file:

- file: `pda 260323.txt`
- imported rows: `105,906`
- `/api/master/import` success
- `/api/master/status` success
- `/api/search` success
- `/api/match` success

## Current Remaining Work

### 1. Production verification after nginx and HTTPS change
Need to verify on real server:

- upload now succeeds through nginx
- API proxy works correctly
- Node server is reachable behind nginx
- SQLite file writes correctly on server

### 2. iPhone real-device scanner verification
Need to verify:

- Safari
- Chrome on iPhone
- permission flow
- native scanner path vs fallback path

### 3. Frontend sync path final verification
Need to confirm:

- app startup loads local IndexedDB
- app also syncs server master when newer
- upload updates both server and local cache

### 4. Clean up encoding/mojibake in old files if still present anywhere
Some earlier source/history had broken Korean strings from encoding mismatch.
Current active app file was rebuilt cleaner, but this should still be checked carefully in deployed UI.

## Last Upload Error Improvement
Not-yet-committed local improvement:

- `src/lib/api.ts`
  If response is `413`, frontend now throws a more specific error mentioning nginx upload size limit.
- `server/index.js`
  If `multer` hits its own size limit, server returns explicit `413`.

Recommended next step:

1. verify production upload now works
2. if confirmed, commit and push these last two local changes

## Recommended Immediate Test Checklist
After server changes:

1. open `https://master.mykrs.com`
2. upload the real master file
3. confirm dashboard shows imported counts
4. open another device/browser
5. confirm same master is searchable
6. test `/api/health`
7. test iPhone scanner
8. test one real barcode exact match
9. test one fuzzy/similar barcode case

## Useful Commands
Local:

```bash
npm install
npm run lint
npm run build
npm run server
```

API quick checks:

```bash
curl https://master.mykrs.com/api/health
curl https://master.mykrs.com/api/master/status
```

## Notes To Next Worker
- Do not commit `data/krsmaster.sqlite`
- Check current `git status` before committing
- Confirm whether production server already pulled commit `e1f5d90`
- If production is now healthy, next likely action is small bugfix commit for the improved 413 error message and final deployment verification
