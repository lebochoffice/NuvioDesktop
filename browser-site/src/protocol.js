// Small, independently testable mirror of Nuvio Desktop's party wire contract.
export const PARTY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizeCode = (input = '') => String(input).toUpperCase().replace(/[\s-]/g, '');
export const validCode = code => /^[A-HJ-NP-Z2-9]{6}$/.test(normalizeCode(code));
export const mediaKey = media => media ? [String(media.meta_type || '').toLowerCase(), media.meta_id, media.season ?? '', media.episode ?? ''].join('|') : '';
export function expectedPositionMs(state, nowMs) {
  if (!state) return 0;
  const at = Number(state.at ?? nowMs);
  const position = Number(state.position_ms || 0);
  return Math.max(0, Math.trunc(position + (state.paused ? 0 : Math.max(0, nowMs - at) * Number(state.rate ?? 1))));
}
// Same sequence tie-break as PartySync.isNewer (member ID, not arrival order).
export const isNewerPlayback = (next, current) => !current || next.seq > current.seq ||
  (next.seq === current.seq && String(next.member_id ?? '') > String(current.member_id ?? ''));
export const validPlayback = p => p && Number.isSafeInteger(p.seq) && p.seq >= 0 &&
  typeof p.paused === 'boolean' && Number.isFinite(p.at) && Number.isFinite(p.position_ms) &&
  p.position_ms >= 0 && Number.isFinite(p.rate ?? 1) && (p.rate ?? 1) >= .25 && (p.rate ?? 1) <= 4;
export function safeStreamUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host.includes(':')) return /^(?:2|3)[0-9a-f]{0,3}:/i.test(host); // Public IPv6 global unicast only.
    if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m && (+m[1] === 0 || +m[1] >= 224 || (+m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) || (+m[1] === 172 && +m[2] >= 16 && +m[2] <= 31))) return false;
    return true;
  } catch { return false; }
}
// TorBox stream hosts (same allowlist as Desktop and the share Worker).
export const TORBOX_STREAM_DOMAINS = ['torbox.app', 'tb-cdn.cx', 'tb-cdn.io', 'tb-cdn.pw', 'tb-cdn.sh', 'tb-cdn.st', 'tb-cdn.to', 'tb-cdn.earth'];
export function isTorboxStreamHost(host) {
  const name = String(host || '').toLowerCase();
  if (!name || name.length > 253 || name.endsWith('.') || name.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return TORBOX_STREAM_DOMAINS.some(domain => name === domain || name.endsWith(`.${domain}`));
}
// Family share: TorBox variant/segment requests that lost the query get the
// share's own token back, only on TorBox stream hosts and only over HTTPS.
export function withFamilyToken(requestUrl, token) {
  if (!token) return requestUrl;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'https:' || !isTorboxStreamHost(url.hostname) || url.searchParams.has('token')) return requestUrl;
    url.searchParams.set('token', token);
    return url.toString();
  } catch { return requestUrl; }
}
// Exact HTTPS origin of the optional family share Worker, or '' (disabled).
export const shareWorkerOrigin = value => {
  const origin = String(value ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(origin) ? origin : '';
};
export const isHlsUrl = url => /\.m3u8(?:[?#]|$)/i.test(url);
export const isDashUrl = url => /\.mpd(?:[?#]|$)/i.test(url);
export const isUnsupportedFile = url => /\.(?:mkv|avi|torrent)(?:[?#]|$)/i.test(url) || /^(?:magnet|ipfs):/i.test(url);
export function streamProblem(stream) {
  if (!safeStreamUrl(stream?.url)) return 'Die Quelle muss eine öffentliche HTTPS-Adresse ohne Benutzername/Passwort sein. Lokale, Torrent- und HTTP-Quellen funktionieren hier nicht.';
  if (Object.keys(stream.headers || {}).length) {
    if (!streamIsHls(stream) || Object.entries(stream.headers).some(([name, value]) =>
      !['accept', 'accept-language'].includes(name.toLowerCase()) ||
      typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value))) {
      return 'Diese HTTP-Header können nicht sicher gesetzt werden. HLS unterstützt Accept und Accept-Language mit serverseitiger CORS-Freigabe; Range verwaltet hls.js selbst. Keine Account-Authorization, Referer- oder User-Agent-Umschreibung.';
    }
  }
  if (Object.keys(stream.response_headers || {}).length) return 'Die Quelle benötigt Änderungen an den Antwort-Headern. Statisches Hosting kann das nicht leisten; CORS muss vom Medienserver selbst erlaubt werden.';
  const names = [stream.url, stream.filename || ''];
  if (names.some(x => isUnsupportedFile(x) || isDashUrl(x))) return 'MKV, AVI, Torrent und DASH werden hier nicht unterstützt. Verwende eine browserkompatible MP4/WebM- oder HLS-Quelle.';
  return '';
}
export const streamIsHls = s => isHlsUrl(s.url) || /\.m3u8$/i.test(s.filename || '') || /hls|mpegurl/i.test(s.stream_type || '');

// Optional extension of the existing stream event. Desktop fields retain the
// original source; browser metadata never changes media_key or playback state.
export function browserPartyStream(stream) {
  if (!stream || !Object.hasOwn(stream, 'browser_hls')) return stream;
  const browser = stream.browser_hls;
  if (!browser || typeof browser !== 'object' || Array.isArray(browser) || browser.state === 'disabled') return null;
  const familyBeta = typeof browser.family_beta_url === 'string' && !!browser.family_beta_url;
  const url = familyBeta ? browser.family_beta_url : browser.url;
  if (typeof url !== 'string' || !url) return null;
  // label: optional display name of the Desktop host (e.g. its own video link).
  const label = typeof browser.label === 'string' ? browser.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return {media_key: stream.media_key, url, headers: familyBeta ? {} : browser.headers || {},
    response_headers: {}, name: label || 'TorBox HLS', stream_type: 'hls', propagate_token: browser.propagate_token === true,
    ...(familyBeta ? {family_beta: true} : {})};
}

export function publicConfigProblem(url, key) {
  if (!url || !key) return 'Backend-Konfiguration fehlt: VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY müssen beim Build gesetzt werden.';
  try {
    const u = new URL(url);
    if (!safeStreamUrl(url) || u.pathname !== '/' || u.search || u.hash) return 'Ungültige Backend-Adresse. Benötigt wird der öffentliche HTTPS-Ursprung des gleichen Backends wie im Desktop.';
    if (key.startsWith('sb_publishable_')) return '';
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role === 'anon') return '';
  } catch { /* No secret key is ever sent to the backend. */ }
  return 'Ungültiger öffentlicher Backend-Key. Nur sb_publishable_ oder ein anon-JWT sind erlaubt; niemals service_role, sb_secret_ oder persönliche Tokens.';
}
export const partyCodeFromPath = pathname => {
  let candidate = '';
  try { candidate = decodeURIComponent((/^\/party\/([^/]+)\/?$/i.exec(pathname) || [])[1] || ''); } catch { return ''; }
  return validCode(candidate) ? normalizeCode(candidate) : '';
};

// Estimated member state relative to the party time (display only; same rule
// as Desktop PartySync.memberSync). report: {status, media_key, position_ms,
// position_at, playing} from a "status" event; never a playback command.
export const REPORT_STALE_MS = 30000, MEMBER_SYNCED_MS = 1000, MEMBER_CATCH_UP_MS = 15000;
export function memberSync(report, playback, currentMediaKey, nowMs) {
  if (!report || (report.media_key && report.media_key !== currentMediaKey)) return {state: 'unknown'};
  if (report.solo === true) return {state: 'solo'}; // Watching alone on purpose: no drift, not "out of sync".
  if (report.status === 'loading' || report.status === 'buffering') return {state: 'buffering'};
  const reported = Number(report.position_ms), at = Number(report.position_at);
  if (!Number.isFinite(reported) || !Number.isFinite(at)) return {state: report.status === 'behind' ? 'unsynced' : 'unknown'};
  if (nowMs - at > REPORT_STALE_MS) return {state: 'stale'};
  const position = reported + (report.playing === true ? Math.max(0, nowMs - at) : 0);
  const drift = playback ? position - expectedPositionMs(playback, nowMs) : null;
  const state = report.status === 'behind' ? 'unsynced' : drift == null ? 'unknown'
    : Math.abs(drift) <= MEMBER_SYNCED_MS ? 'synced' : Math.abs(drift) <= MEMBER_CATCH_UP_MS ? 'catching_up' : 'unsynced';
  return {state, positionMs: Math.round(position), driftMs: drift == null ? null : Math.round(drift)};
}
export function formatDrift(driftMs) {
  const sign = driftMs < 0 ? '−' : '+', ms = Math.abs(driftMs);
  if (ms < 60000) { const tenths = Math.floor((ms + 50) / 100); return `${sign}${Math.floor(tenths / 10)},${tenths % 10} s`; }
  const seconds = Math.floor((ms + 500) / 1000);
  return `${sign}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function memberSyncLabel(info) {
  const drift = info?.driftMs != null ? ` (${formatDrift(info.driftMs)})` : '';
  return {synced: `Synchron${drift}`, catching_up: `Holt auf${drift}`, buffering: 'Puffert',
    unsynced: `Unsynchron${drift}`, solo: 'Allein', stale: 'Status veraltet'}[info?.state] || '';
}
