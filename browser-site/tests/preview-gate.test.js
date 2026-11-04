// Preview password gate (functions/_middleware.js) without Cloudflare: fake
// Pages context, fake asset response. Test-only secrets, never real ones.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {gate, safeNext, isProductionHost, COOKIE_NAME, LOGIN_PATH, LOGOUT_PATH, FAIL_LIMIT, SESSION_S} from '../functions/_middleware.js';

const PREVIEW = 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev';
const HASH = 'https://3f2a9c1b.nuvio-watch-friends.pages.dev';
const PRODUCTION = 'https://nuvio-watch-friends.pages.dev';
const env = {PREVIEW_PASSWORD: 'test-only-password-123456', PREVIEW_COOKIE_SECRET: 'test-only-cookie-secret-0123456789abcdef'};
const noSleep = {sleep: async () => {}};

function call(url, {method = 'GET', headers = {}, body = null, environment = env, now} = {}) {
  let assetCalls = 0;
  const request = new Request(url, {method, headers, body});
  const next = async () => { assetCalls++; return new Response('<html>ASSET_BODY_MARKER</html>', {status: 200, headers: {'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000'}}); };
  return gate({request, env: environment, next}, {...noSleep, ...(now ? {now: () => now} : {})}).then(response => ({response, assetCalls: () => assetCalls}));
}
const form = (fields, origin = PREVIEW) => ({method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin}, body: new URLSearchParams(fields).toString()});
async function login(base = PREVIEW, password = env.PREVIEW_PASSWORD, next = '/party/ABC234', extraHeaders = {}) {
  const options = form({password, next}, base);
  options.headers = {...options.headers, ...extraHeaders};
  return call(`${base}${LOGIN_PATH}`, options);
}
const cookieOf = response => (response.headers.get('Set-Cookie') || '').split(';')[0];

test('production is never gated, not even with missing or broken configuration', async () => {
  for (const environment of [env, {}, {PREVIEW_PASSWORD: 'short'}]) {
    const {response, assetCalls} = await call(`${PRODUCTION}/party/ABC234`, {environment});
    assert.equal(response.status, 200); assert.equal(assetCalls(), 1);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000'); // Untouched.
  }
  assert.ok(isProductionHost('NUVIO-WATCH-FRIENDS.PAGES.DEV'));
  assert.ok(!isProductionHost('feature-party-premium-ui.nuvio-watch-friends.pages.dev'));
  assert.ok(isProductionHost('watch.example.test', {PRODUCTION_HOSTS: 'watch.example.test'}));
});

test('preview without (or with too short) secrets stays closed with 503', async () => {
  for (const environment of [{}, {PREVIEW_PASSWORD: env.PREVIEW_PASSWORD}, {PREVIEW_PASSWORD: 'short', PREVIEW_COOKIE_SECRET: env.PREVIEW_COOKIE_SECRET}, {PREVIEW_PASSWORD: env.PREVIEW_PASSWORD, PREVIEW_COOKIE_SECRET: 'short'}]) {
    const {response, assetCalls} = await call(`${PREVIEW}/`, {environment});
    assert.equal(response.status, 503); assert.equal(assetCalls(), 0);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('unauthenticated visitors get the login page for HTML, assets and routes; nothing is served', async () => {
  for (const path of ['/', '/party/ABC234', '/assets/index-abc123.js', '/index.html', '/.env']) {
    for (const base of [PREVIEW, HASH]) {
      const {response, assetCalls} = await call(`${base}${path}`);
      assert.equal(response.status, 401, `${base}${path}`); assert.equal(assetCalls(), 0);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
      const html = await response.text();
      assert.ok(!html.includes(env.PREVIEW_PASSWORD) && !html.includes('ASSET_BODY_MARKER')); // App content never served.
    }
  }
  const post = await call(`${PREVIEW}/api/anything`, {method: 'POST', body: 'x'});
  assert.equal(post.response.status, 401); assert.equal(post.assetCalls(), 0);
});

test('a correct password sets a HttpOnly, Secure, SameSite session cookie and returns to the requested path', async () => {
  const {response} = await login();
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/party/ABC234');
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=\\d{10}\\.[0-9a-f]{64}; Path=/; Max-Age=${SESSION_S}; Secure; HttpOnly; SameSite=Lax$`));
  assert.ok(!cookie.includes(env.PREVIEW_PASSWORD));
  const authed = await call(`${PREVIEW}/assets/index-abc123.js`, {headers: {Cookie: cookieOf(response)}});
  assert.equal(authed.response.status, 200); assert.equal(authed.assetCalls(), 1);
  assert.equal(authed.response.headers.get('Cache-Control'), 'private, no-store'); // No shared caching of the preview.
  assert.match(authed.response.headers.get('Vary'), /Cookie/);
});

test('wrong passwords fail, never echo input, and are throttled per client IP', async () => {
  const headers = {'CF-Connecting-IP': '203.0.113.50'};
  for (let i = 0; i < FAIL_LIMIT; i++) {
    const {response} = await login(PREVIEW, `wrong-<script>${i}`, '/', headers);
    assert.equal(response.status, 401);
    const html = await response.text();
    assert.ok(!html.includes('<script>') && !html.includes('wrong-'));
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  const blocked = await login(PREVIEW, env.PREVIEW_PASSWORD, '/', headers);
  assert.equal(blocked.response.status, 429); assert.ok(blocked.response.headers.get('Retry-After'));
  assert.equal(blocked.response.headers.get('Set-Cookie'), null); // Even the right password waits.
  const otherIp = await login(PREVIEW, env.PREVIEW_PASSWORD, '/', {'CF-Connecting-IP': '198.51.100.20'});
  assert.equal(otherIp.response.status, 303);
});

test('an optional KV binding counts failures across isolates', async () => {
  const store = new Map();
  const kv = {get: async key => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); }};
  const environment = {...env, PREVIEW_LOGIN_KV: kv};
  const attempt = password => call(`${PREVIEW}${LOGIN_PATH}`, {...form({password, next: '/'}), headers: {...form({}).headers, 'CF-Connecting-IP': '192.0.2.77'}, environment});
  await attempt('wrong');
  assert.equal([...store.values()][0], '1');
  assert.ok(![...store.keys()][0].includes('192.0.2.77')); // IP stored hashed only.
  assert.equal((await attempt(env.PREVIEW_PASSWORD)).response.status, 303);
  assert.equal(store.size, 0); // Success clears the counter.
});

test('no open redirects: next stays on this site and away from the gate', () => {
  for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, '/__preview/login', '/x\u0000y']) assert.equal(safeNext(bad), '/', String(bad));
  assert.equal(safeNext('/party/ABC234?x=1'), '/party/ABC234?x=1');
});

test('sessions are bound to host, password and expiry; forged, foreign or expired cookies fail', async () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const {response} = await call(`${PREVIEW}${LOGIN_PATH}`, {...form({password: env.PREVIEW_PASSWORD, next: '/'}), now});
  const cookie = cookieOf(response);
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, now})).response.status, 200);
  assert.equal((await call(`${HASH}/`, {headers: {Cookie: cookie}, now})).response.status, 401); // Other preview host.
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, now: now + SESSION_S * 1000 + 1000})).response.status, 401); // Expired.
  const rotated = {...env, PREVIEW_PASSWORD: 'another-test-password-987654'};
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, environment: rotated, now})).response.status, 401); // Password change ends sessions.
  const [exp] = cookie.split('=')[1].split('.');
  const forged = `${COOKIE_NAME}=${Number(exp) + 86400}.${'0'.repeat(64)}`;
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: forged}, now})).response.status, 401);
});

test('login and logout reject cross-site posts; logout clears the cookie', async () => {
  assert.equal((await call(`${PREVIEW}${LOGIN_PATH}`, form({password: env.PREVIEW_PASSWORD, next: '/'}, 'https://evil.example'))).response.status, 403);
  assert.equal((await call(`${PREVIEW}${LOGOUT_PATH}`, {method: 'POST', headers: {Origin: 'https://evil.example'}})).response.status, 403);
  const out = await call(`${PREVIEW}${LOGOUT_PATH}`, {method: 'POST', headers: {Origin: PREVIEW}});
  assert.equal(out.response.status, 303); assert.match(out.response.headers.get('Set-Cookie'), /Max-Age=0/);
  const loginGet = await call(`${PREVIEW}${LOGIN_PATH}?next=${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.equal(loginGet.response.status, 200);
  assert.ok(!(await loginGet.response.text()).includes('<script>alert'));
});

test('the login form page sends its real origin on submit (Referrer-Policy same-origin); Origin null stays rejected', async () => {
  for (const url of [`${PREVIEW}/party/ABC234`, `${PREVIEW}${LOGIN_PATH}`]) {
    const {response} = await call(url);
    assert.equal(response.headers.get('Referrer-Policy'), 'same-origin', url); // no-referrer would make the POST send "Origin: null".
  }
  const wrong = await login(PREVIEW, 'wrong-password-123456', '/', {'CF-Connecting-IP': '192.0.2.200'});
  assert.equal(wrong.response.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal((await call(`${PREVIEW}/`, {environment: {}})).response.headers.get('Referrer-Policy'), 'no-referrer'); // Other pages unchanged.
  const nullOrigin = await call(`${PREVIEW}${LOGIN_PATH}`, form({password: env.PREVIEW_PASSWORD, next: '/'}, 'null'));
  assert.equal(nullOrigin.response.status, 403); assert.equal(nullOrigin.response.headers.get('Set-Cookie'), null);
  assert.equal((await login()).response.status, 303); // Same-origin submit works.
});

test('one login per device lasts 30 days, never without an expiry; a password change still ends it', async () => {
  assert.equal(SESSION_S, 30 * 24 * 3600);
  const now = Date.UTC(2026, 10, 5, 12);
  const {response} = await call(`${PREVIEW}${LOGIN_PATH}`, {...form({password: env.PREVIEW_PASSWORD, next: '/'}), now});
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=2592000; Secure; HttpOnly; SameSite=Lax/);
  const cookie = cookieOf(response);
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, now: now + 29 * 86400 * 1000})).response.status, 200);
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, now: now + 31 * 86400 * 1000})).response.status, 401);
  const rotated = {...env, PREVIEW_PASSWORD: 'another-test-password-987654'};
  assert.equal((await call(`${PREVIEW}/`, {headers: {Cookie: cookie}, environment: rotated, now: now + 1000})).response.status, 401);
});
