// Nuvio watch party family share (Cloudflare Worker + Durable Object).
//
// Hands the host's TorBox HLS address, which carries the account token, only
// to party members the host explicitly admitted. No video proxy, no
// transcoding, no logging of URLs, tokens or request bodies.
//
// Trust model:
// - Host and guests authenticate with their own Nuvio (Supabase) session.
// - Membership and the host role are checked on every share/grant through the
//   official watch_party_heartbeat RPC, called with the caller's own JWT; the
//   party code alone grants nothing.
// - Each admitted guest receives its own random, expiring, revocable grant.

export const TORBOX_STREAM_DOMAINS = ['torbox.app', 'tb-cdn.cx', 'tb-cdn.io', 'tb-cdn.pw', 'tb-cdn.sh', 'tb-cdn.st', 'tb-cdn.to', 'tb-cdn.earth'];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const GRANT = /^[A-Za-z0-9_-]{43}$/;
// Short lifetimes: the Desktop renews a share every few minutes while it is
// on, so a crashed host or a host change ends access by itself (S1/S2).
export const LIMITS = {url: 4096, body: 16384, admitted: 16, shareDefaultS: 30 * 60, shareMaxS: 2 * 3600, grantS: 5 * 60};

export function isTorboxStreamHost(host) {
  const name = String(host || '').toLowerCase();
  if (!name || name.length > 253 || name.endsWith('.') || name.split('.').some(label => !HOST_LABEL.test(label))) return false;
  return TORBOX_STREAM_DOMAINS.some(domain => name === domain || name.endsWith(`.${domain}`));
}

export function isTorboxStreamUrl(value) {
  if (typeof value !== 'string' || value.length > LIMITS.url || /[\u0000- \u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port && isTorboxStreamHost(url.hostname);
  } catch { return false; }
}

// Same contract as the Desktop and browser party media key.
export const mediaKey = media => media ? [String(media.meta_type || '').toLowerCase(), media.meta_id, media.season ?? '', media.episode ?? ''].join('|') : '';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers},
});

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin'};
}

const bearer = request => /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(request.headers.get('Authorization') || '')?.[1] || '';

// Authoritative membership: the official RPC with the caller's own session.
export async function partySnapshot(env, jwt, partyId, deviceId, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/watch_party_heartbeat`, {
      method: 'POST',
      headers: {apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({p_party_id: partyId, p_device_id: deviceId}),
    });
    if (!response.ok) return null;
    const snapshot = await response.json();
    if (!snapshot?.party || snapshot.party.id !== partyId || typeof snapshot.member_id !== 'string' || !snapshot.member_id) return null;
    return snapshot;
  } catch { return null; }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) return null;
  try { const body = JSON.parse(text); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, {status: Object.keys(cors).length ? 204 : 403, headers: cors});
    if (request.method !== 'POST') return json(405, {error: 'method'}, cors);
    const action = new URL(request.url).pathname.replace(/^\/v1\//, '');
    if (!['share', 'revoke', 'grant', 'stream'].includes(action)) return json(404, {error: 'not_found'}, cors);
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.PARTY_SHARE) return json(503, {error: 'not_configured'}, cors);
    const body = await readBody(request);
    if (!body || !UUID.test(String(body.party_id || ''))) return json(400, {error: 'invalid'}, cors);
    const partyId = String(body.party_id).toLowerCase();
    const stub = env.PARTY_SHARE.get(env.PARTY_SHARE.idFromName(partyId));
    const forward = payload => stub.fetch(new Request(`https://party-share/${action}`, {method: 'POST', body: JSON.stringify(payload)}))
      .then(async response => json(response.status, await response.json(), cors));

    // A grant is its own credential: no session needed to refresh the address.
    if (action === 'stream') {
      if (!GRANT.test(String(body.grant || ''))) return json(400, {error: 'invalid'}, cors);
      return forward({grant: body.grant});
    }
    const jwt = bearer(request);
    if (!jwt) return json(401, {error: 'auth'}, cors);
    if (!DEVICE_ID.test(String(body.device_id || ''))) return json(400, {error: 'invalid'}, cors);
    const snapshot = await partySnapshot(env, jwt, partyId, body.device_id);
    if (!snapshot) return json(403, {error: 'not_member'}, cors);
    const memberIds = (snapshot.members || []).map(member => member?.id).filter(id => typeof id === 'string');
    const isHost = snapshot.member_id === snapshot.party.host_member_id;

    if (action === 'grant') {
      if (isHost) return json(400, {error: 'host'}, cors);
      return forward({member_id: snapshot.member_id, media_key: mediaKey(snapshot.party.media), host_member_id: snapshot.party.host_member_id});
    }
    if (!isHost) return json(403, {error: 'not_host'}, cors);
    if (action === 'revoke') return forward({});
    // action === 'share'
    if (!isTorboxStreamUrl(body.url)) return json(400, {error: 'url'}, cors);
    if (body.media_key !== mediaKey(snapshot.party.media)) return json(409, {error: 'media'}, cors);
    const admitted = Array.isArray(body.admitted) ? [...new Set(body.admitted.map(String))] : [];
    if (admitted.length > LIMITS.admitted || admitted.some(id => id === snapshot.member_id || !memberIds.includes(id))) return json(400, {error: 'admitted'}, cors);
    const ttl = Math.min(LIMITS.shareMaxS, Math.max(60, Number.isFinite(Number(body.ttl_s)) ? Number(body.ttl_s) : LIMITS.shareDefaultS));
    return forward({url: body.url, media_key: body.media_key, admitted, ttl_s: ttl, propagate_token: body.propagate_token === true, host_member_id: snapshot.member_id});
  },
};

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// One object per party: strongly consistent, so a revocation applies to the
// very next request (unlike eventually consistent KV).
export class PartyShare {
  constructor(ctx, env, now = () => Date.now()) { this.ctx = ctx; this.env = env; this.now = now; }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    const body = await request.json();
    const storage = this.ctx.storage, now = this.now();
    const share = await storage.get('share');
    const active = share && share.expires_at > now ? share : null;

    if (action === 'share') {
      const expiresAt = now + body.ttl_s * 1000;
      // A renewal with unchanged content keeps rev, so browsers do not refetch.
      const same = active && active.url === body.url && active.media_key === body.media_key && active.host_member_id === body.host_member_id &&
        active.propagate_token === body.propagate_token && JSON.stringify([...active.admitted].sort()) === JSON.stringify([...body.admitted].sort());
      const next = {url: body.url, media_key: body.media_key, admitted: body.admitted, expires_at: expiresAt,
        rev: same ? active.rev : (share?.rev || 0) + 1, propagate_token: body.propagate_token, host_member_id: body.host_member_id};
      await storage.put('share', next);
      // Grants of members who are no longer admitted end now.
      for (const [key, grant] of await storage.list({prefix: 'grant:'})) {
        if (!next.admitted.includes(grant.member_id) || grant.media_key !== next.media_key || grant.host_member_id !== next.host_member_id) await storage.delete(key);
      }
      await storage.setAlarm(expiresAt);
      return json(200, {ok: true, rev: next.rev, expires_at: expiresAt});
    }
    if (action === 'revoke') { await storage.deleteAll(); return json(200, {ok: true}); }
    if (action === 'grant') {
      if (!active) return json(404, {error: 'no_share'});
      if (active.media_key !== body.media_key) return json(409, {error: 'media'});
      // Bound to the host who published it: after a host change nothing is granted.
      if (active.host_member_id !== body.host_member_id) return json(403, {error: 'host_changed'});
      if (!active.admitted.includes(body.member_id)) return json(403, {error: 'not_admitted'});
      const bytes = crypto.getRandomValues(new Uint8Array(32)), grant = toBase64Url(bytes);
      const expiresAt = Math.min(active.expires_at, now + LIMITS.grantS * 1000);
      await storage.put(`grant:${await sha256Hex(grant)}`, {member_id: body.member_id, media_key: active.media_key, host_member_id: active.host_member_id, expires_at: expiresAt});
      return json(200, {grant, url: active.url, media_key: active.media_key, rev: active.rev, propagate_token: active.propagate_token, expires_at: expiresAt});
    }
    if (action === 'stream') {
      const key = `grant:${await sha256Hex(body.grant)}`, grant = await storage.get(key);
      if (!grant || grant.expires_at <= now) { if (grant) await storage.delete(key); return json(401, {error: 'grant'}); }
      if (!active || !active.admitted.includes(grant.member_id) || active.media_key !== grant.media_key || active.host_member_id !== grant.host_member_id) {
        await storage.delete(key); return json(403, {error: 'revoked'});
      }
      return json(200, {url: active.url, media_key: active.media_key, rev: active.rev, propagate_token: active.propagate_token, expires_at: grant.expires_at});
    }
    return json(404, {error: 'not_found'});
  }

  // Share expiry removes the address and every grant.
  async alarm() { await this.ctx.storage.deleteAll(); }
}
