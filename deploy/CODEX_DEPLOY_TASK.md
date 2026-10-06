# 서버 배포 작업 지시 (Codex용)

master.mykrs.com 서버에 GitHub 브랜치 `feature/master-editor`의 변경사항을 배포한다.
작업 내용과 배포 절차는 저장소의 `MASTER_EDITOR.md`에 있으니 먼저 읽고 진행한다.

## 환경
- 사이트 코드: `/home/krsmaster/app` (git 저장소, origin = https://github.com/Leebillion/krsmater.git)
- `/home/krsmaster/deploy.sh` 와 `/root/krsmaster-deploy.sh` 가 기존 배포 스크립트다. 먼저 내용을 읽고 현재 구성을 파악한다:
  - 사이트 API(`node server/index.js`)를 무엇으로 실행하는지(pm2 / systemd 등)와 포트
  - nginx 설정 파일 위치(master.mykrs.com의 443 server 블록)
  - nginx가 서비스하는 dist 경로
- root로 작업 중이다.

## 작업 전 백업 (반드시 먼저)
1. 현재 브랜치와 커밋을 기록한다(되돌리기용).
2. `/home/krsmaster/app/data/krsmaster.sqlite` 를 날짜를 붙여 백업한다.
3. master.mykrs.com nginx 설정 파일을 날짜를 붙여 백업한다.
4. `/home/krsmaster/app/.env` 를 백업한다.

## 배포 절차
1. 코드
   ```
   cd /home/krsmaster/app
   git fetch origin && git checkout feature/master-editor && git pull
   npm install && npm run build
   ```
   로컬에 커밋 안 된 변경이 있으면 멈추고 보고한다. 임의로 지우지 않는다.
2. 마스터 편집 서버(Python)
   - `python3 --version` 이 3.10 이상인지 확인한다(아니면 멈추고 보고).
   - `apt install -y python3-venv`
   - `cd /home/krsmaster/app/editor && python3 -m venv venv && venv/bin/pip install -r requirements.txt`
   - `mkdir -p /var/lib/krs-editor`
   - `editor/.env.example` 을 `editor/.env` 로 복사해서 채운다:
     - `APP_PASSWORD` = 사용자에게 물어봐서 넣는다(임의로 정하지 않는다)
     - `SECRET_KEY`, `EDITOR_SHARED_TOKEN` = `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` 로 각각 따로 생성
     - `DATA_DIR=/var/lib/krs-editor`
     - `SITE_API_URL=http://127.0.0.1:<사이트 API 포트, 기본 3100>`
     - `COOKIE_SECURE=1`
     - `chmod 600 editor/.env`
   - `deploy/krs-editor.service` 를 `/etc/systemd/system/krs-editor.service` 로 설치하되, 경로 `/opt/mobile_master` 는 `/home/krsmaster/app` 으로, `User` 는 사이트 API를 실행하는 사용자와 같게 바꾼다.
   - `systemctl daemon-reload && systemctl enable --now krs-editor`
   - `curl http://127.0.0.1:8000/login` 이 200인지 확인한다.
3. 사이트 API 설정
   - `/home/krsmaster/app/.env` 에 추가:
     ```
     EDITOR_INTERNAL_URL=http://127.0.0.1:8000
     EDITOR_SHARED_TOKEN=<editor/.env와 같은 값>
     ```
   - 사이트 API를 기존 방식(pm2 또는 systemd)으로 재시작한다.
4. nginx
   - `deploy/nginx-master-editor.conf` 의 location 블록 두 개를 master.mykrs.com의 443 server 블록 안에 추가한다(기존 `/` 와 `/api` 설정은 건드리지 않는다).
   - 기존 `/api` location 에 `proxy_read_timeout` 이 없으면 `proxy_read_timeout 300s;` 를 추가한다.
   - `nginx -t` 가 성공할 때만 `systemctl reload nginx`. 실패하면 백업으로 되돌리고 보고한다.
5. dist
   - nginx 가 `/home/krsmaster/app/dist` 를 직접 서비스하지 않으면, 기존 deploy 스크립트와 같은 방식으로 새 dist 를 반영한다.

## 확인 (결과를 모두 보고)
- `systemctl status krs-editor --no-pager`
- `curl -s -o /dev/null -w "%{http_code}" https://master.mykrs.com/editor/login` → 200
- `curl -s -o /dev/null -w "%{http_code}" -X POST https://master.mykrs.com/api/master/import` → 401
- `curl -s https://master.mykrs.com/api/health` → ok
- `curl -s https://master.mykrs.com/api/master/status` → 기존 현재 마스터가 그대로 나오는지

## 문제가 생기면 되돌리기
- `git checkout <기록한 원래 브랜치/커밋> && npm run build`, 사이트 API 재시작
- `systemctl disable --now krs-editor`
- nginx 설정과 `.env` 를 백업으로 복원한 뒤 `nginx -t && systemctl reload nginx`

## 주의
- `data/` 폴더의 DB 파일은 지우거나 덮어쓰지 않는다.
- 비밀번호와 토큰 값은 보고서에 그대로 출력하지 않는다.
- 판단이 애매한 곳(포트, 서비스 이름, nginx 파일이 여러 개인 경우 등)은 추측하지 말고 사용자에게 묻는다.
- 마지막에 바꾼 파일 목록, 실행한 명령, 확인 결과를 정리해서 보고한다.
