// Browser host: share a direct, browser-compatible HTTPS video link with the
// party, and check members' proposals. Pure and DOM-free.
//
// The shared source is an ordinary host `stream` offer for the party's own
// media_key (same shape the Desktop host sends), so browser guests play it in
// the existing player and Desktop guests see it as the host's stream. No proxy,
// no transcoding: only direct HLS (.m3u8), MP4 and WebM. Tokenized TorBox HLS
// uses the browser-only field in the explicitly enabled family beta.
import {isTorboxStreamHost, safeStreamUrl, streamProblem, withFamilyToken} from './protocol.js';

export const SHARE_URL_MAX = 4096;

// {kind: 'hls'|'mp4'|'webm', url} or {problem} (short text for the host).
export function classifyShareLink(input, allowFamily = false) {
  const url = typeof input === 'string' ? input.trim() : '';
  if (!url) return {problem: 'Bitte einen Videolink einfügen.'};
  if (url.length > SHARE_URL_MAX || /[\s\u0000-\u001f\u007f]/.test(url)) return {problem: 'Der Link ist ungültig oder zu lang.'};
  if (!safeStreamUrl(url)) return {problem: 'Nur öffentliche HTTPS-Adressen ohne Benutzername/Passwort. Keine lokalen oder HTTP-Adressen.'};
  let path;
  try {
    const parsed = new URL(url);
    if (parsed.hash) return {problem: 'Der Link darf keinen #-Teil enthalten.'};
    if (allowFamily && isTorboxStreamHost(parsed.hostname) && !parsed.port &&
        !parsed.hostname.startsWith('api.') && /\.m3u8$/i.test(parsed.pathname) &&
        parsed.searchParams.getAll('token').length === 1 && parsed.searchParams.get('token') &&
        ![...parsed.searchParams.keys()].some(key => key !== 'token' && /^(?:token|access[_-]?token|api[_-]?key|authorization)$/i.test(key)))
      return {kind: 'hls', url, family: true};
    if (isTorboxStreamHost(parsed.hostname) || [...parsed.searchParams.keys()].some(key => /^(?:token|access[_-]?token|api[_-]?key|authorization)$/i.test(key)))
      return {problem: 'Verwende einen öffentlichen Medienlink ohne Account-Zugangsdaten.'};
    path = parsed.pathname.toLowerCase();
  }
  catch { return {problem: 'Der Link ist ungültig.'}; }
  if (path.endsWith('.m3u8')) return {kind: 'hls', url};
  if (path.endsWith('.mp4')) return {kind: 'mp4', url};
  if (path.endsWith('.webm')) return {kind: 'webm', url};
  return {problem: 'Unterstützt werden direkte HLS- (.m3u8), MP4- und WebM-Links. Seiten, MKV, DASH und Torrents funktionieren nicht.'};
}

// The host's stream offer for the party title, or {problem}.
export function hostShareStream(input, partyMediaKey, allowFamily = false) {
  const link = classifyShareLink(input, allowFamily);
  if (link.problem) return link;
  if (!partyMediaKey) return {problem: 'Die Party hat keine gültige Filmkennung.'};
  if (link.family) return {kind: 'hls', stream: {media_key: partyMediaKey, url: '',
    browser_hls: {state: 'unsupported', label: 'TorBox HLS (Familien-Beta)', family_beta_url: link.url}}};
  const stream = {media_key: partyMediaKey, url: link.url, name: 'Video-Link des Hosts', stream_type: link.kind,
    headers: {}, response_headers: {}};
  const problem = streamProblem(stream);
  return problem ? {problem} : {stream, kind: link.kind};
}

// Only the host name is displayed for a proposal; the full link may carry tokens.
export const linkHost = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return 'unbekannter Host'; } };

// A member's proposal as received by the browser host. Realtime sender IDs
// are claimed, not verified by the server: the proposal is only accepted from
// an ID that is a member in the last server snapshot (not the host itself),
// for the current title, with a shareable link. The name is display only and
// nothing is shared before the host explicitly accepts it.
export function proposalFrom(payload, room, partyMediaKey, allowFamily = false) {
  if (!payload || typeof payload !== 'object' || !room) return null;
  const memberId = typeof payload.member_id === 'string' ? payload.member_id : '';
  const member = room.members?.find(item => item.id === memberId);
  if (!member || memberId === room.memberId || payload.media_key !== partyMediaKey) return null;
  const link = classifyShareLink(payload.url, allowFamily);
  if (link.problem) return null;
  const name = String(member.display_name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Mitglied';
  return {memberId, name, url: link.url, kind: link.kind, host: linkHost(link.url)};
}

// Reject redirects and foreign origins before Fetch sends a request.
export function familyHlsRequest(source, target, init) {
  const link = classifyShareLink(source, true);
  if (!link.family) throw new Error('Ungültige Familienquelle.');
  const playlist = new URL(link.url), resource = new URL(target, playlist);
  if (resource.origin !== playlist.origin || resource.username || resource.password)
    throw new Error('Die Playlist verweist auf eine andere Medienadresse.');
  return new Request(withFamilyToken(resource.href, playlist.searchParams.get('token')),
    {...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'});
}
