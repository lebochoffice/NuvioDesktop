// Shared separate video ("links" protocol 1 of the Nuvio Desktop fork): a
// YouTube video or a direct MP4/WebM file that the Desktop host shares for the
// whole party. It has its own identity, never the party media_key:
//   key = "link:<id>:<rev>"  → media_key of its states, commands and status.
// Every replacement raises rev, so late events of an earlier source (or of the
// film) cannot steer the current player. Pure and DOM-free.
import {safeStreamUrl} from './protocol.js';
import {classifyVideoLink, isYouTubeVideoId} from './smart-video-link.js';

export const LINK_PROTOCOL = 1;
export const SHARED_KINDS = Object.freeze(['youtube', 'mp4', 'webm']);
const SOURCE_ID = /^[A-Za-z0-9]{8,32}$/;
export const sharedSourceKey = (id, rev) => `link:${id}:${rev}`;
export const isSharedSourceKey = key => typeof key === 'string' && key.startsWith('link:');

// Host payload → normalized source, or null for anything malformed, for another
// film, or with an address that is not a public HTTPS file of the stated kind.
export function parseSharedSource(raw, partyKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !partyKey) return null;
  const {id, rev, kind} = raw;
  if (typeof id !== 'string' || !SOURCE_ID.test(id) || !Number.isSafeInteger(rev) || rev < 1 || !SHARED_KINDS.includes(kind)) return null;
  const key = sharedSourceKey(id, rev);
  if (raw.key !== key || raw.party_key !== partyKey) return null;
  const label = typeof raw.label === 'string' ? raw.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  if (kind === 'youtube') return isYouTubeVideoId(raw.video_id) && raw.url == null ? {key, id, rev, kind, videoId: raw.video_id, label} : null;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!url || url.length > 4096 || url.includes('#') || !safeStreamUrl(url) || classifyVideoLink(url).kind !== kind) return null;
  return {key, id, rev, kind, url, label};
}

// stream_suggest payload fields for a classified Smart Video Link. YouTube
// sends only the video ID and a canonical watch address (no tracking, list or
// time parameters); the host rebuilds the address from the ID anyway.
export function suggestionFields(source) {
  if (source?.kind === 'youtube' && isYouTubeVideoId(source.id)) {
    return {kind: 'youtube', video_id: source.id, url: `https://www.youtube.com/watch?v=${source.id}`};
  }
  if (['mp4', 'webm', 'hls'].includes(source?.kind) && typeof source.url === 'string') return {kind: source.kind, url: source.url};
  return null;
}

// The <video> stream object for a shared file: same shape as a host stream,
// so the proven HTML5 sync path (applySync) plays it unchanged.
export const sharedFileStream = source => ({media_key: source.key, url: source.url, headers: {}, response_headers: {},
  name: source.label || source.kind.toUpperCase(), stream_type: source.kind, shared_link: true});
