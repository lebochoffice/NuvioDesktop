import {safeStreamUrl} from './protocol.js';

const origin = 'https://v3-cinemeta.strem.io';
const imdbId = /^tt[0-9]{7,12}$/;
const mediaTypes = ['movie', 'series'];
const posterUrl = value => typeof value === 'string' && value.length <= 2048 && safeStreamUrl(value)
  ? new URL(value).href : undefined;
const catalogRequest = () => ({
  credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(15000),
});

export async function searchRoomMedia(query, fetchImpl = fetch) {
  const search = encodeURIComponent(query.trim());
  const groups = await Promise.all(mediaTypes.map(async type => {
    const response = await fetchImpl(`${origin}/catalog/${type}/top/search=${search}.json`, catalogRequest());
    if (!response.ok) throw new Error('Titelsuche fehlgeschlagen.');
    const {metas} = await response.json();
    if (!Array.isArray(metas)) throw new Error('Ungültige Antwort des Titelkatalogs.');
    const seen = new Set();
    const results = [];
    for (const meta of metas) {
      if (typeof meta?.id !== 'string' || !imdbId.test(meta.id) || meta.type !== type ||
          typeof meta.name !== 'string' || !meta.name.trim() || seen.has(meta.id)) continue;
      seen.add(meta.id);
      const year = /^(\d{4})/.exec(String(meta.releaseInfo ?? meta.year ?? ''))?.[1];
      results.push({id: meta.id, type, title: meta.name.trim().slice(0, 200), poster: posterUrl(meta.poster), year});
      if (results.length === 6) break;
    }
    return results;
  }));
  return groups.flat();
}

export async function resolveRoomMedia(type, input, season, episode, fetchImpl = fetch) {
  const value = typeof input === 'string' ? input.trim() : '';
  const id = /^tt[0-9]{7,12}$/.test(value) ? value
    : /^https:\/\/(?:www\.)?imdb\.com\/title\/(tt[0-9]{7,12})\/?$/.exec(value)?.[1];
  if (!['movie', 'series'].includes(type) || !id ||
      type === 'series' && (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1))
    throw new Error('Gültige IMDb-ID und bei Serien Staffel und Episode angeben.');
  const details = await loadRoomTitle(type, id, fetchImpl);
  return roomMediaForEpisode(details, season, episode);
}

export async function loadRoomTitle(type, id, fetchImpl = fetch) {
  if (!mediaTypes.includes(type) || typeof id !== 'string' || !imdbId.test(id)) throw new Error('Ungültige Medienidentität.');
  const response = await fetchImpl(`${origin}/meta/${type}/${id}.json`, catalogRequest());
  if (!response.ok) throw new Error('Titel konnte im Katalog nicht bestätigt werden.');
  const {meta} = await response.json();
  if (meta?.id !== id || meta.type !== type || typeof meta.name !== 'string' || !meta.name.trim())
    throw new Error('Der Katalog hat keine passende Medienidentität geliefert.');
  const media = {type, meta_type: type, meta_id: id, title: meta.name.trim().slice(0, 200)};
  if (typeof meta.description === 'string' && meta.description.trim())
    media.description = meta.description.trim().slice(0, 2000);
  const poster = posterUrl(meta.poster);
  if (poster) media.poster = poster;
  const videos = type === 'series' && Array.isArray(meta.videos) ? meta.videos : [];
  const byEpisode = new Map();
  for (const video of videos) {
    if (!Number.isInteger(video?.season) || video.season < 0 || !Number.isInteger(video.episode) || video.episode < 1) continue;
    const key = `${video.season}:${video.episode}`;
    byEpisode.set(key, !byEpisode.has(key) && typeof video.id === 'string' && video.id.trim() ? video : null);
  }
  return {media, episodes: [...byEpisode.values()].filter(Boolean).sort((a, b) => a.season - b.season || a.episode - b.episode)};
}

export function roomMediaForEpisode(details, season, episode) {
  if (details.media.type === 'movie') return details.media;
  const video = details.episodes.find(item => item.season === season && item.episode === episode);
  if (!video) throw new Error('Die gewählte Episode konnte nicht eindeutig bestätigt werden.');
  return {...details.media, season, episode, video_id: video.id};
}

