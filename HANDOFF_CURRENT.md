# KRS Master Handoff

## Current Summary
KRS Master now includes:

- shared server-side master sync with Express + SQLite
- local browser cache restore on startup
- scanner / search / bundle / upload bottom navigation
- compact top status badges under the `KRS Master` title
- bundle reporting, bundle report status management, and bundle master search flows

## Current Working Areas

### 1. Product Master
- server APIs for active master upload, full sync, search, and matching are in place
- app restores local IndexedDB data, then syncs newer server master automatically
- header message now shows `서버 마스터 동기화 완료` when server sync wins

### 2. Bundle Menu
Bundle menu order and tabs are currently:

- `번들 제보`
- `번들 제보 상황`
- `번들 검색`

Implemented behavior:

- bundle report save to SQLite
- bundle report DB Excel download
- bundle report status list / edit / delete
- bundle master Excel upload
- bundle master search by product name or barcode

### 3. Bundle Input / Validation
- bundle report field limits are enforced at input time
- barcode fields allow `1~13` digits, including leading `0`
- name fields are limited to `30byte`
- quantity is limited to `2` digits

### 4. Bundle Master Upload Rules
Current upload behavior:

- first row is treated as header
- empty rows are skipped with warning messages
- duplicate bundle barcode warns and keeps the later row
- duplicate item barcode warns and continues
- bundle master search no longer supports full-list load by default; search term is required

Accepted headers include practical variants such as:

- `번들바코드`
- `번들상품명`
- `입수`
- `상품코드`
- `상품명`

## Recent Fixes

### Bundle Report Status
- added `GET /api/bundles/report`
- added `PUT /api/bundles/report/:id`
- added `DELETE /api/bundles/report/:id`
- bundle report status tab now loads saved reports and supports inline correction

### Runtime Issue Found And Fixed
Observed issue:

- `번들 제보 상황` showed `제보 목록을 불러오지 못했다` style error

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
- running local API must be restarted after backend route changes
- direct PowerShell `Invoke-WebRequest` with Korean JSON may show mojibake in console, but app/browser flow is normal when UTF-8 request path is used

## Recommended Next Checks
1. verify bundle report status list on actual deployed server
2. normalize display of old UTC-saved bundle report times if needed
3. consider adding search/filter inside `번들 제보 상황` when report count grows
4. clean remaining mojibake strings in backend source messages when convenient

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
