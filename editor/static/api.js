// Thin fetch wrapper: JSON in/out, CSRF header, login redirect, readable errors.

const CSRF = { "X-Requested-With": "master-reducer" };

// The app may be served under a path prefix (e.g. /editor/ inside master.mykrs.com),
// so every URL is resolved relative to the page instead of the site root.
export function appUrl(path) {
  return path.replace(/^\/+/, "");
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function handle(response) {
  if (response.status === 401) {
    window.location.href = appUrl("login");
    throw new ApiError("로그인이 필요합니다.", 401);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.message || body.detail || `요청 실패 (${response.status})`, response.status);
  }
  return body;
}

export async function get(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ).toString();
  const url = appUrl(path);
  return handle(await fetch(query ? `${url}?${query}` : url, { credentials: "same-origin" }));
}

export async function post(path, body = {}) {
  return handle(
    await fetch(appUrl(path), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...CSRF },
      body: JSON.stringify(body),
    }),
  );
}

export async function upload(path, file, fields = {}) {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return handle(await fetch(appUrl(path), { method: "POST", credentials: "same-origin", headers: CSRF, body: form }));
}

// CP949 byte width used for the live counters: ASCII is 1 byte, everything else 2.
// The server re-validates with the real encoder, so this only drives the UI hint.
export function cp949Bytes(text) {
  let total = 0;
  for (const ch of text) total += ch.codePointAt(0) < 0x80 ? 1 : 2;
  return total;
}

export function truncateBytes(text, width) {
  let total = 0;
  let out = "";
  for (const ch of text) {
    const size = ch.codePointAt(0) < 0x80 ? 1 : 2;
    if (total + size > width) break;
    total += size;
    out += ch;
  }
  return out;
}
