# 마스터 편집 (관리자) — KRS Master 병합 안내

KRS Master(master.mykrs.com)에 본사 마스터 감축·출력 도구(원래 별도 웹 앱 `masternew/web_app`)를 **'마스터 편집' 메뉴**로 합쳤다.

## 사용자 구분

| 구분 | 기능 | 로그인 |
|---|---|---|
| 일반 사용자 | 스캐너, 검색, 번들 제보·제보 현황·번들 검색, 변환(엑셀·사진 OCR), 업로드 메뉴의 현황 조회 | 없음 |
| 관리자 | **마스터 편집**(감축, 팀장용·팀원용·PDA·Full·폐점 출력, 상품 DB, krs_gs25 통합 엑셀), **현재 마스터 교체**, **번들 마스터 교체**, **사이트 현재 마스터로 게시** | 공용 관리자 비밀번호 |

- 현재 마스터·번들 마스터 교체는 모든 사용자의 검색·스캐너 기준을 바꾸므로 관리자 전용으로 바꿨다. 이전에는 로그인 없이 누구나 `/api/master/import`, `/api/bundles/master/import`를 호출할 수 있었다.
- 관리자 비밀번호는 마스터 편집 서버가 확인한다. 마스터 편집 메뉴에서 로그인하면 같은 쿠키로 업로드 메뉴의 교체 기능도 열린다. 로그아웃하면 다시 잠긴다.

## 구조

```
브라우저 ── nginx (master.mykrs.com)
             ├─ /          dist/ (React, PWA)
             ├─ /api/      Express :3100  (server/)   ← 사이트 API, SQLite data/krsmaster.sqlite
             └─ /editor/   FastAPI :8000  (editor/)   ← 마스터 편집, SQLite editor 데이터 폴더
```

- 마스터 편집은 사이트 안 '마스터 편집' 메뉴에 같은 도메인 iframe으로 열린다. '새 창으로 열기'로 따로 열 수도 있다(`/editor/`).
- 규칙(감축·출력·통합 엑셀) 코드는 데스크톱 앱과 같은 `master_reducer` 패키지를 쓴다. 같은 입력이면 출력 파일이 데스크톱 앱과 바이트 단위로 같다.
- 두 서버의 DB는 따로다. 사이트 DB는 '현재 마스터·번들 마스터·번들 제보·변환 저장', 편집 DB는 '종량제·번들·단축·서비스·담배·삭제한 행·검색어'다.

### 관리자 확인 흐름 (`server/adminAuth.js`)

1. 브라우저 업로드: Express가 요청의 `mr_session` 쿠키만 골라 편집 서버 `GET /api/me`에 물어본다(5초 제한, 이 요청은 편집 서버의 작업 잠금을 기다리지 않는다).
2. 사이트 게시(서버 간): 편집 서버가 `X-Editor-Token` 헤더로 공유 비밀값을 보내고, Express가 상수 시간 비교로 확인한다.
3. 둘 다 아니면 `401 관리자 로그인이 필요합니다`.

### 사이트 게시

마스터 편집 → ④ 출력 → `출력 저장…` → **사이트 게시 (KRS Master)**에서 출력 하나를 고르면, 파일 저장(zip 다운로드)과 함께 그 출력이 사이트의 현재 마스터를 바로 교체한다. 내부적으로 기존 `POST /api/master/import`를 그대로 써서 파서와 저장 방식은 업로드와 같다. 게시에 실패해도 zip은 정상으로 받을 수 있고, 결과 창에 실패 이유가 나온다.

## 화면 변경 (React)

- 상단·하단 메뉴에 `마스터 편집` 추가. 로그인 전에는 비밀번호 입력, 로그인 후에는 편집 화면 + `새 창으로 열기` + `로그아웃`.
- 업로드 메뉴: 관리자가 아니면 '상품 마스터 업로드' 칸과 '번들 마스터' 카드의 업로드 버튼 대신 '관리자 전용' 안내와 `마스터 편집으로 이동` 버튼. 현재 마스터·번들 마스터·변환 현황·최근 업로드 조회는 그대로.
- 같이 고친 기존 버그: '오프라인 준비 완료'·'새 버전' 배너의 바깥 줄이 화면 폭 전체를 덮어서, 배너가 떠 있는 동안 PC 상단 메뉴가 눌리지 않았다(배너를 닫아야 눌림). 바깥 줄은 클릭을 통과시키도록 수정.
- PWA: 서비스 워커가 `/editor`, `/api` 탐색을 사이트 `index.html`로 대신 답하지 않도록 `navigateFallbackDenylist` 추가, 편집 화면 파일은 런타임 캐시에서 제외.

## 코드 위치와 동기화

| 위치 | 내용 |
|---|---|
| `editor/master_reducer/` | 규칙 패키지 (데스크톱 앱과 공용, tkinter 화면 제외) |
| `editor/server/`, `editor/static/`, `editor/tests/` | 마스터 편집 서버·화면·API 테스트 |
| `server/adminAuth.js` | 관리자 확인 |
| `src/KrsMasterApp.tsx`, `src/lib/api.ts` | 마스터 편집 메뉴, 업로드 잠금 |
| `deploy/` | nginx 설정 조각, 편집 서버 systemd 서비스 |
| `scripts/sync-editor.ps1` | 원본에서 editor/로 다시 복사 |

**editor/ 안의 코드는 직접 고치지 않는다.** 원본은 `masternew`(데스크톱 앱 폴더)의 `master_reducer/`, `web_app/`이다. 원본을 고친 뒤 `powershell -ExecutionPolicy Bypass -File scripts\sync-editor.ps1`로 가져온다. 마지막 복사 시점은 `editor/SOURCE.txt`에 남는다.

## 배포 (master.mykrs.com 서버)

기존 사이트 배포(빌드한 `dist/` + `node server/index.js`)에 다음을 더한다.

1. 편집 서버 준비
   ```bash
   cd /opt/mobile_master/editor
   python3 -m venv venv && venv/bin/pip install -r requirements.txt
   cp .env.example .env && nano .env      # APP_PASSWORD, SECRET_KEY, EDITOR_SHARED_TOKEN 등
   sudo mkdir -p /var/lib/krs-editor && sudo chown www-data /var/lib/krs-editor
   # 기존 상품 DB로 시작하려면: sudo cp master_management.db /var/lib/krs-editor/
   sudo cp ../deploy/krs-editor.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now krs-editor
   ```
2. 사이트 `.env`에 `EDITOR_INTERNAL_URL=http://127.0.0.1:8000`, `EDITOR_SHARED_TOKEN=`(editor/.env와 같은 값) 추가 후 사이트 API 재시작
3. nginx에 `deploy/nginx-master-editor.conf` 내용 추가 → `sudo nginx -t && sudo systemctl reload nginx`
4. `npm run build` 후 `dist/` 배포 (서비스 워커 설정이 바뀌었으므로 반드시 새로 빌드)
5. 확인: 로그인 없이 업로드 메뉴가 잠기는지, 마스터 편집 로그인 후 편집 화면이 뜨는지, 게시가 되는지

**주의:** 배포 직후부터는 관리자 비밀번호 없이 현재 마스터·번들 마스터를 교체할 수 없다. 지금 업로드를 맡는 사람들에게 비밀번호를 미리 알려 둔다.

## 로컬 개발

```bash
# 터미널 1: 사이트 API      EDITOR_SHARED_TOKEN=dev npm run server
# 터미널 2: 마스터 편집     cd editor && APP_PASSWORD=dev COOKIE_SECURE=0 SITE_API_URL=http://127.0.0.1:3100 EDITOR_SHARED_TOKEN=dev python -m uvicorn server.main:create_app --factory --port 8000
# 터미널 3: 화면            npm run dev   (vite가 /api → 3100, /editor → 8000으로 넘긴다)
```

## 검증 기록 (2026-10-06)

- `npm run lint`, `npm run build`, `node --check server/index.js server/adminAuth.js` 통과
- 편집 서버 API 테스트 14개 통과(`cd editor && python -m pytest tests`): 로그인·실패 제한·CSRF·보안 헤더(같은 도메인에서만 iframe 허용)·업로드→감축→zip·세션 분리·`/api/me`·사이트 게시 성공/거부(토큰 불일치)/미설정
- 브라우저 E2E(Playwright, 사이트 빌드 + 두 서버를 운영과 같은 경로로 연결, 데이터는 복사본): 비로그인 마스터 교체 API 401, 업로드 메뉴 잠금 안내, 틀린 비밀번호 거부, 로그인 후 편집 화면 표시, 출력 저장에서 사이트 게시 → 사이트 현재 마스터가 게시한 팀장용(3,717건)으로 교체, 로그인 후 업로드 메뉴 열림, `/editor/` 직접 접속 시 서비스 워커가 가로채지 않음, 로그아웃 후 다시 잠김 — 10개 모두 통과, 브라우저 오류 0
- 실제 서버 배포와 휴대폰 화면 확인은 하지 않았다
