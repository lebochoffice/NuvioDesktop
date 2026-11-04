import {personalHlsUrlProblem} from './personal-hls.js';
import {isTorboxStreamHost} from './protocol.js';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
export const isYouTubeVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);

// Classification uses the URL alone. An extensionless link from an unknown
// provider can still be explicitly tried as HLS, without suggesting it.
export function classifyVideoLink(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!/^https:\/\//i.test(value) || value.includes('\\') || personalHlsUrlProblem(value)) return {kind: 'unsupported'};
  const url = new URL(value);
  if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.port) return {kind: 'unsupported'};
    if (url.hostname !== 'youtu.be' && /^\/live(?:\/|$)/.test(url.pathname)) {
      return {kind: 'unsupported', reason: 'youtube_live'};
    }
    const ids = url.searchParams.getAll('v');
    const id = url.hostname === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
      : url.pathname === '/watch' && ids.length === 1 ? ids[0]
      : /^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return isYouTubeVideoId(id) ? {kind: 'youtube', id} : {kind: 'unsupported'};
  }
  if (/\.m3u8$/i.test(url.pathname)) return {kind: 'hls', url: value};
  if (/\.mp4$/i.test(url.pathname)) return {kind: 'mp4', url: value};
  if (/\.webm$/i.test(url.pathname)) return {kind: 'webm', url: value};
  if (/\.(?:mpd|mkv|avi)$/i.test(url.pathname)) return {kind: 'unsupported'};
  if (isTorboxStreamHost(url.hostname)) return {kind: 'hls', url: value};
  return /\.[^/]+\/?$/.test(url.pathname) || url.pathname === '/' ? {kind: 'unsupported'}
    : {kind: 'unsupported', hlsCandidate: value};
}
