# editor — 마스터 편집 서버

KRS Master 사이트의 '마스터 편집'(관리자) 메뉴를 제공하는 FastAPI 서버다. 구조·배포·관리자 규칙은 루트의 [MASTER_EDITOR.md](../MASTER_EDITOR.md)를 본다.

- 이 폴더의 `master_reducer/`, `server/`, `static/`, `tests/`, `requirements.txt`는 원본(`masternew`)에서 `scripts/sync-editor.ps1`로 복사한 것이다. 여기서 직접 고치지 말고 원본을 고친 뒤 다시 동기화한다(`SOURCE.txt`에 마지막 복사 시점).
- 설정은 `.env.example`을 `.env`로 복사해 채운다.
- 테스트: `python -m pytest tests`
