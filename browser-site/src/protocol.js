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
  if (!browser || typeof browser !== 'object' || Array.isArray(browser) || typeof browser.url !== 'string' || !browser.url) return null;
  return {media_key: stream.media_key, url: browser.url, headers: browser.headers || {},
    response_headers: {}, name: 'TorBox HLS', stream_type: 'hls'};
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
