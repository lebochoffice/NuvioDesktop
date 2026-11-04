// Password gate for Cloudflare Pages PREVIEW deployments (branch aliases and
// per-deployment hash URLs). The production host always passes through
// untouched. Runs for every request (HTML, assets, routes), because Pages
// routes all requests through Functions when no _routes.json excludes them.
//
// Secrets (Pages > Settings > Variables and Secrets, Preview environment):
//   PREVIEW_PASSWORD        at least 16 characters
//   PREVIEW_COOKIE_SECRET   at least 32 characters (random)
// Optional binding: PREVIEW_LOGIN_KV (KV namespace) for login throttling
// across isolates; without it the throttle is per isolate only.
// Missing or too short secrets on a preview host: 503, never open.
// Nothing here logs passwords, cookies or form data.

export const PRODUCTION_HOSTS = ['nuvio-watch-friends.pages.dev'];
export const COOKIE_NAME = '__Host-nuvio_preview';
export const LOGIN_PATH = '/__preview/login';
export const LOGOUT_PATH = '/__preview/logout';
export const SESSION_S = 12 * 3600;
export const MIN_PASSWORD = 16;
export const MIN_COOKIE_SECRET = 32;
export const FAIL_LIMIT = 8;
export const FAIL_WINDOW_S = 15 * 60;
const FAIL_DELAY_MS = 750;
const MAX_FORM_BYTES = 4096;

const encoder = new TextEncoder();
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
// Constant time for equal lengths; both sides are fixed-length hex digests.
function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isProductionHost(hostname, env = {}) {
  const extra = String(env.PRODUCTION_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  return [...PRODUCTION_HOSTS, ...extra].includes(String(hostname || '').toLowerCase());
}

// Only same-site paths; never another origin, protocol-relative or backslash tricks.
export function safeNext(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\') || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) return '/';
  try {
    const url = new URL(text, 'https://gate.invalid');
    if (url.origin !== 'https://gate.invalid' || url.pathname.startsWith('/__preview/')) return '/';
    return url.pathname + url.search;
  } catch { return '/'; }
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(status, title, body, extra = {}) {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}main{max-width:360px;width:100%}input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #555;background:#222;color:#eee}button{width:100%;padding:10px;border:0;border-radius:8px;background:#e50914;color:#fff;font-weight:600}p.error{color:#ff8a80}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, ...PRIVATE_HEADERS, ...extra}});
}

// The login form posts to this same origin. With "no-referrer" browsers send
// "Origin: null" on that POST (Fetch standard), which sameOrigin() rightly
// rejects; "same-origin" sends the real origin here and nothing cross-site.
const LOGIN_REFERRER = {'Referrer-Policy': 'same-origin'};
const loginPage = (next, error = '', status = 401, extra = {}) => page(status, 'Nuvio Preview',
  `<h1>Nuvio Preview</h1><p>Diese Testversion ist passwortgeschützt.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
<label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Anmelden</button></form>`, {...LOGIN_REFERRER, ...extra});

// Secrets present and long enough; otherwise the preview stays closed.
export function gateConfig(env = {}) {
  const password = typeof env.PREVIEW_PASSWORD === 'string' ? env.PREVIEW_PASSWORD : '';
  const cookieSecret = typeof env.PREVIEW_COOKIE_SECRET === 'string' ? env.PREVIEW_COOKIE_SECRET : '';
  if (password.length < MIN_PASSWORD || cookieSecret.length < MIN_COOKIE_SECRET) return null;
  return {password, cookieSecret};
}

// exp.signature; bound to the host and to the current password (a password
// change ends every session).
async function sessionToken(config, host, exp) {
  const fingerprint = (await sha256(config.password)).slice(0, 16);
  return `${exp}.${await hmac(config.cookieSecret, `v1|${exp}|${host}|${fingerprint}`)}`;
}
export async function createSession(config, host, now = Date.now()) {
  return sessionToken(config, host, Math.floor(now / 1000) + SESSION_S);
}
export async function validSession(request, config, host, now = Date.now()) {
  const cookie = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  const value = cookie?.slice(COOKIE_NAME.length + 1) || '';
  const match = /^(\d{10})\.([0-9a-f]{64})$/.exec(value);
  if (!match || Number(match[1]) <= Math.floor(now / 1000)) return false;
  return sameDigest(value, await sessionToken(config, host, Number(match[1])));
}
const sessionCookie = token => `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_S}; Secure; HttpOnly; SameSite=Lax`;
const clearCookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

// Login throttle per client IP: KV across isolates if bound, else per isolate.
const memoryFailures = new Map();
async function failureKey(request) { return `preview-login-fail:${await sha256(request.headers.get('CF-Connecting-IP') || 'unknown')}`; }
async function failureCount(env, key, now) {
  if (env.PREVIEW_LOGIN_KV?.get) { try { return Number(await env.PREVIEW_LOGIN_KV.get(key)) || 0; } catch { /* Fall back to memory. */ } }
  const entry = memoryFailures.get(key);
  return entry && entry.until > now ? entry.count : 0;
}
async function recordFailure(env, key, count, now) {
  if (env.PREVIEW_LOGIN_KV?.put) { try { await env.PREVIEW_LOGIN_KV.put(key, String(count + 1), {expirationTtl: FAIL_WINDOW_S}); return; } catch { /* Fall back to memory. */ } }
  memoryFailures.set(key, {count: count + 1, until: now + FAIL_WINDOW_S * 1000});
  if (memoryFailures.size > 10000) memoryFailures.clear();
}
async function clearFailures(env, key) {
  memoryFailures.delete(key);
  if (env.PREVIEW_LOGIN_KV?.delete) { try { await env.PREVIEW_LOGIN_KV.delete(key); } catch { /* Expires anyway. */ } }
}

const sameOrigin = (request, url) => { const origin = request.headers.get('Origin'); return !origin || origin === url.origin; };

async function handleLogin(context, config, url, options) {
  const {request, env} = context;
  if (!sameOrigin(request, url)) return page(403, 'Nuvio Preview', '<p>Ungültige Anfrage.</p>');
  const now = options.now();
  const key = await failureKey(request);
  const failures = await failureCount(env, key, now);
  if (failures >= FAIL_LIMIT) return loginPage('/', 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.', 429, {'Retry-After': String(FAIL_WINDOW_S)});
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_FORM_BYTES) return page(413, 'Nuvio Preview', '<p>Anfrage zu groß.</p>');
  let password = '', next = '/';
  try {
    const form = await request.formData();
    password = String(form.get('password') || ''); next = String(form.get('next') || '/');
  } catch { /* Treated as a failed attempt. */ }
  if (password.length <= 1024 && sameDigest(await sha256(password), await sha256(config.password))) {
    await clearFailures(env, key);
    const token = await createSession(config, url.hostname, now);
    return new Response(null, {status: 303, headers: {Location: safeNext(next), 'Set-Cookie': sessionCookie(token), ...PRIVATE_HEADERS}});
  }
  await recordFailure(env, key, failures, now);
  await options.sleep(FAIL_DELAY_MS);
  return loginPage(next, 'Passwort falsch.');
}

export async function gate(context, options = {}) {
  const opts = {now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...options};
  const {request, env = {}, next} = context;
  const url = new URL(request.url);
  // Production is never gated, whatever the configuration.
  if (isProductionHost(url.hostname, env)) return next();
  const config = gateConfig(env);
  if (!config) return page(503, 'Nuvio Preview', '<h1>Nuvio Preview</h1><p>Der Preview-Schutz ist nicht eingerichtet. Diese Testversion bleibt gesperrt.</p>');
  if (url.pathname === LOGIN_PATH) {
    if (request.method === 'POST') return handleLogin(context, config, url, opts);
    return loginPage(url.searchParams.get('next') || '/', '', 200);
  }
  if (url.pathname === LOGOUT_PATH && request.method === 'POST') {
    if (!sameOrigin(request, url)) return page(403, 'Nuvio Preview', '<p>Ungültige Anfrage.</p>');
    return new Response(null, {status: 303, headers: {Location: LOGIN_PATH, 'Set-Cookie': clearCookie, ...PRIVATE_HEADERS}});
  }
  if (await validSession(request, config, url.hostname, opts.now())) {
    const response = await next();
    const result = new Response(response.body, response);
    for (const [name, value] of Object.entries({'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow'})) result.headers.set(name, value);
    result.headers.append('Vary', 'Cookie');
    return result;
  }
  if (request.method === 'GET' || request.method === 'HEAD') return loginPage(url.pathname + url.search);
  return new Response('Preview login required', {status: 401, headers: {'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS}});
}

export const onRequest = context => gate(context);
