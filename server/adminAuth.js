import { timingSafeEqual } from 'crypto';

// 관리자(마스터 편집) 권한 확인.
// 마스터 편집 서버(editor/, Python)가 공용 비밀번호 로그인을 맡고, 이 서버는 두 가지 방법으로 관리자를 확인한다.
//  1) 브라우저: 마스터 편집 로그인 쿠키(mr_session)를 편집 서버의 /api/me에 물어본다.
//  2) 서버 간 호출: 마스터 편집의 '사이트 현재 마스터로 게시'가 보내는 X-Editor-Token(공유 비밀값).
const editorUrl = (process.env.EDITOR_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const sharedToken = process.env.EDITOR_SHARED_TOKEN || '';
const SESSION_COOKIE = 'mr_session';

export async function isAdminRequest(req) {
  const token = req.get('x-editor-token');
  if (token && sharedToken && safeEqual(token, sharedToken)) return true;

  const session = readCookie(req.get('cookie'), SESSION_COOKIE);
  if (!session) return false;
  try {
    // 편집 서버로는 로그인 쿠키 하나만 넘긴다.
    const response = await fetch(`${editorUrl}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function requireAdmin(req, res, next) {
  isAdminRequest(req)
    .then((ok) => {
      if (ok) {
        next();
        return;
      }
      res.status(401).json({ error: '관리자 로그인이 필요합니다. 마스터 편집 메뉴에서 로그인한 뒤 다시 시도하세요.' });
    })
    .catch(next);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
