// Family share Worker without Cloudflare: fake Durable Object storage and a
// fake watch_party_heartbeat. No real keys, URLs or accounts.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import worker, {PartyShare, isTorboxStreamHost, isTorboxStreamUrl, LIMITS, RETRY_AFTER_S} from '../src/index.js';

const PARTY = '0b7f5a52-6a3e-4c55-9f43-1b2a3c4d5e6f';
const FAKE_KEY = 'FAKE_ACCOUNT_TOKEN_FOR_TESTS';
const URL_WITH_TOKEN = `https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0?token=${FAKE_KEY}`;
const MEDIA = {meta_type: 'movie', meta_id: 'tt1'};
const ORIGIN = 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev';

class Storage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { return this.map.delete(key); }
  async deleteAll() { this.map.clear(); }
  async list({prefix}) { return new Map([...this.map].filter(([key]) => key.startsWith(prefix))); }
  async setAlarm(at) { this.alarm = at; }
}

function setup(extraEnv = {}) {
  let clock = 1_000_000;
  const storage = new Storage(), object = new PartyShare({storage}, {}, () => clock);
  // Session -> current membership as the official RPC would report it.
  const sessions = new Map([
    ['host-session-aaaaaaaaaaaaaaaa', {member_id: 'm-host'}],
    ['anna-session-aaaaaaaaaaaaaaaa', {member_id: 'm-anna'}],
    ['ben-session-bbbbbbbbbbbbbbbbb', {member_id: 'm-ben'}],
  ]);
  const party = {id: PARTY, host_member_id: 'm-host', media: {...MEDIA}};
  const rpcCalls = [];
  globalThis.fetch = async (url, init) => {
    rpcCalls.push({url, auth: init.headers.Authorization});
    const session = sessions.get(init.headers.Authorization.replace('Bearer ', ''));
    if (!session) return new Response(JSON.stringify({code: 'not_member'}), {status: 400});
    return new Response(JSON.stringify({party: structuredClone(party), member_id: session.member_id,
      members: [...sessions.values()].map(s => ({id: s.member_id}))}), {status: 200});
  };
  const env = {SUPABASE_URL: 'https://backend.example.test', SUPABASE_ANON_KEY: 'sb_publishable_TEST', ALLOWED_ORIGINS: ORIGIN,
    PARTY_SHARE: {idFromName: name => name, get: () => ({fetch: request => object.fetch(request)})}, ...extraEnv};
  const call = async (action, body, session, origin = ORIGIN, ip = '203.0.113.7') => {
    const headers = {'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip};
    if (session) headers.Authorization = `Bearer ${session}`;
    const response = await worker.fetch(new Request(`https://share.example.test/v1/${action}`, {method: 'POST', headers, body: JSON.stringify({party_id: PARTY, device_id: 'device-1', ...body})}), env);
    return {status: response.status, body: await response.json(), headers: response.headers};
  };
  const share = (admitted = ['m-anna'], extra = {}) => call('share', {url: URL_WITH_TOKEN, media_key: 'movie|tt1||', admitted, ...extra}, 'host-session-aaaaaaaaaaaaaaaa');
  return {call, share, storage, sessions, party, rpcCalls, advance: ms => { clock += ms; }};
}

test('TorBox host allowlist matches the Desktop: official CDNs only, exact boundaries', () => {
  assert.ok(isTorboxStreamHost('flux-007.wnam.tb-cdn.io'));
  for (const domain of ['tb-cdn.cx', 'tb-cdn.io', 'tb-cdn.pw', 'tb-cdn.sh', 'tb-cdn.st', 'tb-cdn.to', 'tb-cdn.earth', 'torbox.app']) assert.ok(isTorboxStreamHost(`a.${domain}`), domain);
  for (const host of ['evil-tb-cdn.io', 'tb-cdn.io.evil.example', 'xtorbox.app', 'flux.tb-cdn.io.', '127.0.0.1', '']) assert.ok(!isTorboxStreamHost(host), host);
  assert.ok(isTorboxStreamUrl(URL_WITH_TOKEN));
  for (const url of ['http://a.tb-cdn.io/x', 'https://u:p@a.tb-cdn.io/x', 'https://a.tb-cdn.io:8443/x', 'https://a.tb-cdn.io/x#f', 'https://evil.example/x']) assert.ok(!isTorboxStreamUrl(url), url);
});

test('only the verified host can share, and only to current members it admits', async () => {
  const h = setup();
  assert.equal((await h.call('share', {url: URL_WITH_TOKEN, media_key: 'movie|tt1||', admitted: ['m-anna']}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 403);
  assert.equal((await h.call('share', {url: URL_WITH_TOKEN, media_key: 'movie|tt1||', admitted: ['m-anna']}, null)).status, 401);
  assert.equal((await h.share(['m-stranger'])).status, 400); // Not a member.
  assert.equal((await h.share(['m-host'])).status, 400);
  assert.equal((await h.share(['m-anna'], {url: 'https://evil.example/a.m3u8?token=x'})).status, 400);
  assert.equal((await h.share(['m-anna'], {media_key: 'movie|tt9||'})).status, 409);
  const ok = await h.share();
  assert.equal(ok.status, 200); assert.equal(ok.body.rev, 1);
  assert.ok(!JSON.stringify(ok.body).includes(FAKE_KEY)); // The host gets no echo of the address.
});

test('an admitted guest gets its own grant and the original address; others get nothing', async () => {
  const h = setup(); await h.share();
  const anna = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  assert.equal(anna.status, 200); assert.equal(anna.body.url, URL_WITH_TOKEN); // Token kept unchanged.
  assert.match(anna.body.grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(anna.headers.get('Access-Control-Allow-Origin'), ORIGIN); assert.equal(anna.headers.get('Cache-Control'), 'no-store');
  const ben = await h.call('grant', {}, 'ben-session-bbbbbbbbbbbbbbbbb');
  assert.equal(ben.status, 403); assert.ok(!JSON.stringify(ben.body).includes(FAKE_KEY)); // Member, but not admitted.
  const stranger = await h.call('grant', {}, 'stranger-session-cccccccccc');
  assert.equal(stranger.status, 403); assert.ok(!JSON.stringify(stranger.body).includes(FAKE_KEY)); // Knows the party id, no membership.
  assert.equal((await h.call('grant', {}, null)).status, 401);
  // Grants are stored hashed only.
  assert.ok(![...h.storage.map.keys()].some(key => key.includes(anna.body.grant)));
  const second = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  assert.notEqual(second.body.grant, anna.body.grant); // Separate random grant per request.
});

test('reconnect refreshes with the grant; revocation, removal and expiry end every further fetch', async () => {
  const h = setup(); await h.share();
  const {body: {grant}} = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  const again = await h.call('stream', {grant}, null);
  assert.equal(again.status, 200); assert.equal(again.body.url, URL_WITH_TOKEN);
  await h.share([]); // Host withdraws Anna's admission.
  assert.equal((await h.call('stream', {grant}, null)).status, 401); // Grant deleted.
  await h.share(['m-anna']);
  const renewed = (await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).body.grant;
  h.sessions.delete('anna-session-aaaaaaaaaaaaaaaa'); // Kicked: the RPC no longer knows her.
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 403);
  h.advance(LIMITS.grantS * 1000 + 1);
  assert.equal((await h.call('stream', {grant: renewed}, null)).status, 401); // Grant expired.
  const fresh = setup(); await fresh.share();
  const g = (await fresh.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).body.grant;
  assert.equal((await fresh.call('revoke', {}, 'host-session-aaaaaaaaaaaaaaaa')).status, 200);
  assert.equal((await fresh.call('stream', {grant: g}, null)).status, 401);
  assert.equal((await fresh.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 404);
  assert.equal(fresh.storage.map.size, 0); // Nothing kept after revocation.
});

test('a share expires, the alarm removes it, and an episode change needs a new share', async () => {
  const h = setup(); await h.share(['m-anna'], {ttl_s: 120});
  assert.ok(h.storage.alarm > 0);
  h.party.media = {meta_type: 'series', meta_id: 'tt2', season: 1, episode: 2};
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 409); // Old episode's address.
  h.party.media = {...MEDIA};
  h.advance(121_000);
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 404);
});

test('foreign origins get no CORS access; malformed requests are rejected without RPC', async () => {
  const h = setup(); await h.share();
  const foreign = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa', 'https://evil.example');
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const calls = h.rpcCalls.length;
  assert.equal((await h.call('grant', {party_id: 'not-a-uuid'}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 400);
  assert.equal((await h.call('stream', {grant: 'short'}, null)).status, 400);
  assert.equal(h.rpcCalls.length, calls);
});

test('a share is bound to the host who published it: after a host change nothing is granted', async () => {
  const h = setup(); await h.share();
  const {body: {grant}} = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  h.party.host_member_id = 'm-ben'; // Backend promoted another member (old host crashed).
  const refused = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  assert.equal(refused.status, 403); assert.equal(refused.body.error, 'host_changed');
  assert.ok(!JSON.stringify(refused.body).includes(FAKE_KEY));
  // The new host may publish its own share; that ends the old host's grants.
  assert.equal((await h.call('share', {url: URL_WITH_TOKEN, media_key: 'movie|tt1||', admitted: ['m-anna']}, 'ben-session-bbbbbbbbbbbbbbbbb')).status, 200);
  assert.equal((await h.call('stream', {grant}, null)).status, 401);
});

test('short lifetimes: a renewal keeps rev, and an unrenewed share ends within its 30 min default', async () => {
  assert.equal(LIMITS.grantS, 5 * 60); assert.equal(LIMITS.shareDefaultS, 30 * 60); assert.ok(LIMITS.shareMaxS <= 2 * 3600);
  const h = setup();
  assert.equal((await h.share()).body.rev, 1);
  assert.equal((await h.share()).body.rev, 1); // Same content: browsers do not refetch.
  assert.equal((await h.share(['m-anna', 'm-ben'])).body.rev, 2);
  const capped = await h.share(['m-anna'], {ttl_s: 24 * 3600});
  assert.ok(capped.body.expires_at - 1_000_000 <= LIMITS.shareMaxS * 1000);
  const fresh = setup(); await fresh.share(['m-anna'], {ttl_s: undefined});
  fresh.advance(LIMITS.shareDefaultS * 1000 + 1); // Host crashed: no renewal.
  assert.equal((await fresh.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 404);
});

// Fake of the Workers Rate Limiting binding: a fixed budget per key.
class Limiter {
  constructor(limit) { this.limit_ = limit; this.counts = new Map(); this.keys = []; }
  async limit({key}) { this.keys.push(key); const n = (this.counts.get(key) || 0) + 1; this.counts.set(key, n); return {success: n <= this.limit_}; }
}

test('rate limiting answers 429 before any body parsing or Supabase RPC, with Retry-After and CORS', async () => {
  const grantLimit = new Limiter(2);
  const h = setup({GRANT_RATE_LIMIT: grantLimit});
  await h.share();
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 200);
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 200);
  const rpcBefore = h.rpcCalls.length;
  const limited = await h.call('grant', {}, 'stranger-session-cccccccccc');
  assert.equal(limited.status, 429); assert.equal(limited.body.error, 'rate_limited');
  assert.equal(limited.headers.get('Retry-After'), String(RETRY_AFTER_S));
  assert.equal(limited.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(limited.headers.get('Access-Control-Expose-Headers'), /Retry-After/);
  assert.equal(h.rpcCalls.length, rpcBefore); // No RPC for a throttled request.
  assert.ok(!JSON.stringify(limited.body).includes(FAKE_KEY));
  assert.deepEqual([...new Set(grantLimit.keys)], ['203.0.113.7']); // Per client IP within the grant budget.
  // Another IP has its own budget.
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa', ORIGIN, '198.51.100.9')).status, 200);
});

test('separate budgets: an exhausted grant budget never blocks reconnects through /v1/stream', async () => {
  const h = setup({GRANT_RATE_LIMIT: new Limiter(1), STREAM_RATE_LIMIT: new Limiter(60), SHARE_RATE_LIMIT: new Limiter(10)});
  await h.share();
  const {body: {grant}} = await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa');
  assert.equal((await h.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 429);
  for (let i = 0; i < 20; i++) assert.equal((await h.call('stream', {grant}, null)).status, 200); // Family reconnects.
  // Host renewals and admission changes stay within the share budget.
  for (let i = 0; i < 8; i++) assert.equal((await h.share()).status, 200);
});

test('share and revoke are throttled together; a missing or failing limiter never blocks access', async () => {
  const shareLimit = new Limiter(1);
  const h = setup({SHARE_RATE_LIMIT: shareLimit});
  assert.equal((await h.share()).status, 200);
  assert.equal((await h.call('revoke', {}, 'host-session-aaaaaaaaaaaaaaaa')).status, 429);
  assert.deepEqual(shareLimit.keys, ['203.0.113.7', '203.0.113.7']); // One budget for share and revoke.
  const broken = setup({GRANT_RATE_LIMIT: {limit: async () => { throw new Error('limiter down'); }}});
  await broken.share();
  assert.equal((await broken.call('grant', {}, 'anna-session-aaaaaaaaaaaaaaaa')).status, 200);
});
