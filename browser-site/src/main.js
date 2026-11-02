import {createClient} from '@supabase/supabase-js';
import Hls from 'hls.js';
import './style.css';
import {normalizeCode, validCode, partyCodeFromPath, mediaKey, expectedPositionMs, isNewerPlayback, streamProblem, streamIsHls, browserPartyStream, publicConfigProblem} from './protocol.js';
import {PartySession, callRpc} from './session.js';
import {PersonalHlsSource, personalHlsUrlProblem} from './personal-hls.js';
import {SYNC, HLS_TUNING, bufferedRanges, bufferAhead, correctionFor, seekTarget, SeekLead, StallTracker, qualityOptions} from './sync-policy.js';

const $ = id => document.getElementById(id);
const player = $('player');
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
// Shared browser control when the host allows it (host_only=false):
//   unset/'desktop' → same as Nuvio Desktop guests: broadcast, then persist
//                     (owner decision; same trust model as Desktop guests)
//   '1'/'confirmed' → only after watch_party_update returned this command
//   'off'           → local controls only
const guestControlSetting = String(import.meta.env.VITE_PARTY_GUEST_CONTROL ?? '').trim().toLowerCase();
const guestControlMode = guestControlSetting === 'off' ? 'off' : ['1', 'confirmed'].includes(guestControlSetting) ? 'confirmed' : 'desktop';
const guestControlEnabled = guestControlMode !== 'off';
const configProblem = publicConfigProblem(url, key);
const client = configProblem ? null : createClient(url, key, {
  auth: {autoRefreshToken: true, persistSession: true, detectSessionInUrl: false},
  // Keep the JSON Phoenix protocol usable by existing Nuvio Realtime servers.
  realtime: {vsn: '1.0.0', params: {nuvio_realtime: '1'}},
});
// A tab owns one membership. Separate guest tabs must not evict one another.
let deviceId;
try {
  deviceId = sessionStorage.getItem('nuvio-party-device') || crypto.randomUUID();
  sessionStorage.setItem('nuvio-party-device', deviceId);
} catch { deviceId = crypto.randomUUID(); }
let hls = null, selectedStream = null, loadedStream = null, syncEnabled = false;
let suppressUntil = 0, loading = false, buffering = false;
let pendingChat = null;
let pendingSeek = null, internalHlsSeek = null, pendingPlay = null;
let waitingForTarget = false;
let lastAlignedPlayback = null;
let presenceRoom = null, lastPresence = null;
const stallTracker = new StallTracker(), seekLead = new SeekLead();
let nudging = false, lastCorrectiveSeekAt = -Infinity, seekSettled = true, leadSeekStartedAt = null;
let bufferingEvents = 0, segmentStats = {loadMs: null, durationS: null};
// Guest control: optimistic command until the server confirms or rejects it.
let pendingCommand = null, queuedCommand = null, userSeekPending = false;
let expectedPauses = 0, mediaPointerDown = false, mediaGestureUntil = -1;
let lastPlaybackError = 'none', debugOutput = null, debugEnabled = false;
try { debugEnabled = sessionStorage.getItem('nuvio-party-debug') === '1'; } catch { /* Local opt-in unavailable. */ }
let personalReadinessMessage = '';
const personalHls = new PersonalHlsSource(Hls, player, {
  onInternalSeek: seconds => { internalHlsSeek = {seconds}; },
  onInstance: instance => watchHlsInstance(instance),
  onPlaylist: playlist => {
    $('personalHlsStatus').textContent = playlist.message;
    updatePersonalHlsReadiness(true);
  },
  onError: message => { $('personalHlsStatus').textContent = message; failVideo(message, 'hls_error'); },
});
const session = client ? new PartySession(client, deviceId, {
  room: room => {
    if (personalHls.active && personalHls.mediaKey !== mediaKey(room.info.media)) resetVideo('Filmkennung geändert. Bitte eine eigene Quelle für den neuen Film laden.');
    $('movieTitle').textContent = playerTitle(room.info.media);
    $('movieInfo').textContent = `Host: ${room.members.find(m => m.id === room.info.host_member_id)?.display_name || 'Unbekannt'} · Bis zu ${room.info.max_members || 3} Personen`;
    renderMembers(room);
    renderControlInfo();
    showPanel('watch');
  },
  connection: state => {
    connectionLost = state !== 'SUBSCRIBED';
    $('connection').textContent = state === 'SUBSCRIBED' ? 'Verbunden' : 'Verbindung unterbrochen';
    renderPlayerUi();
    if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state)) {
      syncEnabled = false;
      pauseLocally();
      $('resync').textContent = 'Party-Zeit aktualisieren';
      status('Privater Realtime-Kanal nicht verbunden. Anmeldung, Backend-Freigabe und Netzwerk prüfen. Nach Wiederverbindung erneut synchronisieren.', true);
    }
  },
  playback: () => { updatePersonalHlsReadiness(); applySync(); renderSyncDebug(); },
  stream: stream => {
    // Includes revocations, incompatible URLs and host source changes. Only an
    // authoritative media/room lifecycle event clears a personal source.
    if (personalHls.active) return;
    if (stream && stream.media_key !== mediaKey(session.room?.info.media)) return;
    const browserPending = !!stream && Object.hasOwn(stream, 'browser_hls');
    stream = browserPartyStream(stream);
    if (!stream) {
      resetVideo();
      $('streamInfo').textContent = browserPending
        ? 'Desktop-Quelle freigegeben. Browser-HLS ist noch nicht verfügbar; bitte auf die Vorbereitung warten oder die eigene HLS-Quelle verwenden.'
        : 'Keine aktive Streamfreigabe. Der Desktop-Host muss „Share my stream“ aktivieren.';
      return;
    }
    if (stream.media_key !== mediaKey(session.room?.info.media)) return;
    const identity = JSON.stringify(stream);
    if (identity === JSON.stringify(selectedStream)) return;
    // Do not keep playing a revoked or superseded source until the next user click.
    resetVideo(); selectedStream = stream;
    $('streamInfo').textContent = `Freigegebene Quelle: ${stream.name || stream.filename || 'Video'}. Laden überträgt deine IP-Adresse an den Medienanbieter. Die Quelladresse kann private Tokens enthalten.`;
    const problem = streamProblem(stream);
    $('loadStream').hidden = !!problem;
    if (problem) { $('noStream').textContent = 'Diese Quelle kann der Browser nicht abspielen. Der Host kann eine andere Quelle teilen.'; status(problem, true); }
    else { $('noStream').textContent = 'Stream bereit. Tippe auf ▶, um gemeinsam zu schauen.'; status('Stream bereit. Tippe auf ▶ zum Abspielen.'); }
  },
  media: () => { resetVideo('Film gewechselt. Persönliche Quelle entfernt. Bitte eine neue eigene Quelle laden.'); $('streamInfo').textContent = 'Film gewechselt. Warte auf die neue Streamfreigabe oder lade eine eigene HLS-Quelle.'; },
  chat: message => {
    const line = document.createElement('div'), author = document.createElement('b');
    author.textContent = `${message.name || session.room?.members.find(m => m.id === message.member_id)?.display_name || 'Gast'}: `;
    line.append(author, document.createTextNode(message.body || ''));
    $('chatLog').append(line);
    if ($('chatLog').children.length > 100) $('chatLog').firstChild.remove();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  },
  error: e => status(friendlyError(e), true),
  closed: () => { resetVideo('Party-Verbindung geschlossen. Persönliche Quelle entfernt.'); $('chatLog').replaceChildren(); pendingChat = null; $('connection').textContent = 'Nicht verbunden'; renderControlInfo(); },
  ended: message => { resetVideo('Party beendet oder Mitgliedschaft verloren. Persönliche Quelle entfernt.'); showPanel('join'); status(message); },
}) : null;

// Transient toast instead of a permanent banner; errors stay a little longer.
let toastTimer = null, connectionLost = false;
function status(message, error = false) {
  $('message').textContent = message;
  $('message').style.borderColor = error ? '#ff6969' : '';
  $('message').hidden = !message;
  globalThis.clearTimeout?.(toastTimer);
  toastTimer = setTimeout(() => { $('message').hidden = true; }, error ? 9000 : 4500);
}
function showPanel(name) {
  for (const panel of ['auth', 'join', 'watch']) $(panel + 'Section').hidden = panel !== name;
  // The invitation card frames both pre-join steps (sign-in and name);
  // the cinema view hides the brand bar.
  $('inviteView').hidden = name === 'watch';
  $('brandbar').hidden = name === 'watch';
  $('joinButton').textContent = session?.room ? 'Zurück zur Party' : 'Jetzt ansehen';
  if (name !== 'watch') closeDrawer();
}
function setClass(element, name, on) {
  const names = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
  if (on) names.add(name); else names.delete(name);
  element.className = [...names].join(' ');
}
// "Snowfall · S2 E10 · Lehrgeld" for episodes, the plain title for films.
function playerTitle(media) {
  const title = String(media?.title || '').trim(), episodeTitle = String(media?.episode_title || '').trim();
  const code = Number.isInteger(media?.season) ? `S${media.season}${Number.isInteger(media?.episode) ? ` E${media.episode}` : ''}` : '';
  return [title, code, episodeTitle && episodeTitle !== title ? episodeTitle : ''].filter(Boolean).join(' · ') || 'Watch Party';
}
const initials = name => (String(name || '?').trim().match(/\S/gu) || ['?']).slice(0, 1).join('').toUpperCase();
// Only https images from party metadata; everything else falls back.
function safeImageUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}
function showImage(element, value) {
  const src = safeImageUrl(value);
  element.hidden = !src;
  if (!src) { element.removeAttribute?.('src'); return; }
  element.onerror = () => { element.hidden = true; };
  element.src = src;
}
function renderAvatar(element, member) {
  element.textContent = initials(member?.display_name);
  const color = /^#[0-9a-f]{3,8}$/i.test(member?.avatar_color || '') ? member.avatar_color : '';
  element.style.background = color;
}
function renderMembers(room) {
  const list = $('memberList');
  list.replaceChildren(...room.members.map(member => {
    const item = document.createElement('li'), avatar = document.createElement('span'), name = document.createElement('span');
    avatar.className = 'avatar'; renderAvatar(avatar, member);
    name.className = 'name'; name.textContent = member.display_name || 'Gast';
    item.append(avatar, name);
    if (member.id === room.info.host_member_id) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Host'; item.append(badge); }
    if (member.id === room.memberId) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Du'; item.append(badge); }
    return item;
  }));
  // Compact strip under the player: up to five avatars plus the count.
  $('memberAvatars').replaceChildren(...room.members.slice(0, 5).map(member => {
    const avatar = document.createElement('span');
    avatar.className = member.id === room.info.host_member_id ? 'avatar host' : 'avatar'; renderAvatar(avatar, member);
    return avatar;
  }));
  $('memberCount').textContent = `${room.members.length}/${room.info.max_members || 3} Teilnehmer`;
  $('drawerCode').textContent = room.info.code || '–';
}
// Invitation from watch_party_preview: rendered with textContent only; no
// stream source or private data is shown.
function renderInvite(p) {
  const media = p?.media || {}, host = p?.host;
  const series = media.meta_type === 'series' || Number.isInteger(media.season);
  const title = media.title || 'Watch Party';
  $('inviteHostLine').textContent = host?.display_name ? `${host.display_name} lädt dich ein` : ''; $('inviteHostLine').hidden = !host?.display_name;
  $('inviteTitle').textContent = title;
  const episode = series && Number.isInteger(media.season) ? `S${media.season} E${media.episode ?? '?'}${media.episode_title ? ' · ' + media.episode_title : ''}` : '';
  $('inviteEpisode').textContent = episode; $('inviteEpisode').hidden = !episode;
  $('inviteDescription').textContent = media.description || ''; $('inviteDescription').hidden = !media.description;
  showImage($('inviteBackdrop'), media.background || media.poster);
  showImage($('inviteLogo'), media.logo);
  $('inviteHost').textContent = host?.display_name || '–';
  renderAvatar($('inviteHostAvatar'), host);
  const max = Number(p?.max_members) || 0, taken = Math.min(Number(p?.members) || 0, max || 99);
  $('inviteSeats').textContent = max ? `${taken} von ${max} belegt` : '–';
  $('inviteSeatDots').replaceChildren(...Array.from({length: Math.min(max, 12)}, (_, i) => {
    const dot = document.createElement('i'); if (i < taken) dot.className = 'on'; return dot;
  }));
}
function friendlyError(e) {
  const messages = {party_full: 'Die Party ist voll.', party_not_found: 'Party nicht gefunden.', party_ended: 'Die Party wurde beendet.', removed: 'Du wurdest aus der Party entfernt.', not_member: 'Du bist kein Mitglied mehr.', rate_limited: 'Zu viele Anfragen. Bitte kurz warten.', unavailable: 'Watch Party ist für dieses Backend nicht verfügbar.', PGRST202: 'Das Backend bietet diese Nuvio-RPC-Version nicht an. Backend und Desktop-Konfiguration prüfen.'};
  return messages[e?.code || e?.message] || e?.message || 'Unbekannter Fehler';
}
function pauseLocally() {
  pendingPlay = null; suppressUntil = performance.now() + 1000;
  // Match the actual pause event even if the browser dispatches it much later.
  if (!player.paused) expectedPauses++;
  player.pause();
}
function resetVideo(reason = 'Persönliche Quelle entfernt. Für diesen Film kann eine neue eigene Quelle geladen werden.') {
  pendingSeek = internalHlsSeek = pendingPlay = null;
  waitingForTarget = false;
  lastAlignedPlayback = null; lastPresence = null;
  resetSyncState(); renderQuality(null); clearSubtitles();
  mediaPointerDown = false; mediaGestureUntil = -1; lastPlaybackError = 'none';
  personalHls.clear();
  personalReadinessMessage = '';
  $('personalHlsUrl').value = '';
  $('useDesktopStream').hidden = true;
  $('personalHlsStatus').textContent = reason;
  syncEnabled = false; loading = false; buffering = false;
  selectedStream = loadedStream = null;
  if (hls) { hls.destroy(); hls = null; }
  pauseLocally(); player.removeAttribute('src'); player.load();
  $('noStream').hidden = false; $('loadStream').hidden = true;
  $('noStream').textContent = 'Warte auf eine freigegebene Streamquelle des Hosts …';
  $('streamInfo').textContent = 'Warte auf eine Desktop-Freigabe oder lade eine eigene zulässige HLS-Quelle (Beta).';
  $('resync').disabled = true; $('resync').textContent = 'Party-Zeit aktualisieren';
}
function updatePersonalHlsReadiness(announce = false) {
  if (!personalHls.active || !loadedStream) return;
  const target = session?.playback ? expectedPositionMs(session.playback, session.now()) / 1000 : NaN;
  const result = personalHls.syncTarget(target);
  $('resync').disabled = !result.ready;
  const message = result.ready
    ? (syncEnabled ? 'VOD-Quelle folgt der Party-Zeit. Bild, Ton und identische Filmfassung müssen tatsächlich geprüft werden.' : 'VOD-Playlist und aktueller Suchbereich erkannt. Wiedergabe und vollständiges Seek sind noch nicht bestätigt. Zum Start synchronisieren.')
    : result.message;
  if (result.ready) {
    const wasLoading = loading;
    loading = false; $('noStream').hidden = true;
    if (wasLoading) presence();
  }
  if (announce || personalReadinessMessage !== message) {
    personalReadinessMessage = message;
    $('personalHlsStatus').textContent = message;
    if (!syncEnabled) status(message);
  }
}
function presence() {
  if (!session?.room) return;
  let state = 'browsing';
  // Only sustained starvation pauses the party (Desktop coordinator waits on
  // "buffering"). Short mobile stalls stay local; hysteresis avoids flapping,
  // and a guest that exhausted its wait budget catches up alone ("behind").
  // A play promise or a routine seek is not itself a reason to pause everyone.
  const stallState = stallTracker.update(performance.now(), !!loadedStream && syncEnabled && (buffering || waitingForTarget || loading));
  if (loadedStream) state = syncEnabled ? stallState : 'behind';
  // Waiting for consent or an unsupported source must never stall the whole party.
  if (loading && !syncEnabled) state = 'browsing';
  const gap = session.playback ? Math.max(5000, expectedPositionMs(session.playback, session.now()) - player.currentTime * 1000) : 5000;
  const behind = state === 'behind' ? Math.round(gap / 5000) * 5000 : undefined;
  const signature = `${state}:${behind ?? ''}`;
  if (presenceRoom === session.room && lastPresence === signature) return;
  presenceRoom = session.room; lastPresence = signature;
  session.sendPresence(state, behind).catch(() => {
    if (lastPresence === signature) lastPresence = null;
    status('Status nicht gesendet. Party-Verbindung prüfen.', true);
  });
}
// The own command is followed optimistically until the server confirms it; a
// newer accepted party state (other member, host) always wins.
function effectivePlayback() {
  const party = session?.playback, own = pendingCommand?.playback;
  return own && isNewerPlayback(own, party) ? own : party;
}
function applySync(forcePlay = false) {
  const p = effectivePlayback();
  if (!syncEnabled || !p || !loadedStream) return;
  // Host pause must not wait for metadata, seekability or buffer recovery.
  if (p.paused) { pendingPlay = null; if (!player.paused) pauseLocally(); }
  if (player.readyState < 1) return;
  let desired = expectedPositionMs(p, session.now()) / 1000;
  if (personalHls.active) {
    const target = personalHls.syncTarget(desired);
    if (!target.ready) {
      if (!target.retryable) syncEnabled = false;
      waitingForTarget = !!target.retryable;
      pauseLocally(); presence();
      $('resync').disabled = true; $('resync').textContent = 'Party-Zeit aktualisieren';
      $('personalHlsStatus').textContent = target.message; status(target.message, true);
      return;
    }
    desired = target.seconds;
    waitingForTarget = false;
  } else if (Number.isFinite(player.duration)) desired = Math.max(0, Math.min(Math.max(0, player.duration - .1), desired));
  const drift = player.currentTime - desired;
  // A missing seeked event must not impose a five-second delay if the native
  // seek is already complete. Keep the latest host command queued otherwise.
  if (pendingSeek && !player.seeking && (Math.abs(player.currentTime - pendingSeek.seconds) < .05 || performance.now() - pendingSeek.at > 5000)) pendingSeek = null;
  const rate = p.rate ?? 1;
  const correction = correctionFor({drift, paused: p.paused, nudging, rate});
  const needsSeek = correction.kind === 'seek';
  // Queue the latest accepted command during a native seek. Once seeked fires,
  // apply it immediately, including when the old target was still buffering.
  // For the same command, never re-seek while segments still load; after a
  // corrective seek, wait until playback resumed or the cooldown elapsed.
  const newCommand = lastAlignedPlayback !== p || forcePlay;
  const recovered = seekSettled || performance.now() - lastCorrectiveSeekAt >= SYNC.seekCooldownMs;
  if (!pendingSeek && !player.seeking && needsSeek && (newCommand || (!buffering && recovered))) {
    suppressUntil = performance.now() + 1000;
    try {
      // Unbuffered targets need a download while the party continues: land
      // ahead by the measured recovery delay instead of chasing the host.
      const target = seekTarget({desired, paused: p.paused, ranges: bufferedRanges(player.buffered), leadS: seekLead.seconds, duration: player.duration});
      pendingSeek = {seconds: target.seconds, at: performance.now()};
      player.currentTime = target.seconds;
      lastAlignedPlayback = p;
      lastCorrectiveSeekAt = performance.now(); seekSettled = false;
      leadSeekStartedAt = !target.buffered && !p.paused ? performance.now() : null;
    }
    catch {
      pendingSeek = null;
      lastPlaybackError = 'seek_failed';
      syncEnabled = false; pauseLocally(); presence();
      $('resync').textContent = 'Party-Zeit aktualisieren';
      const message = 'Der Browser konnte den Party-Zeitpunkt nicht anspringen. Bitte einen suchbaren VOD-Stream verwenden und erneut synchronisieren.';
      if (personalHls.active) $('personalHlsStatus').textContent = message;
      status(message, true); return;
    }
  }
  if (!needsSeek) lastAlignedPlayback = p;
  // Hysteresis like Desktop (start 250 ms, stop 80 ms): no per-tick rate
  // flapping. No nudging while stalled or seeking; it cannot help there.
  nudging = correction.kind === 'nudge' && !buffering && !pendingSeek && !player.seeking;
  const nextRate = nudging ? correction.rate : rate;
  if (player.playbackRate !== nextRate) player.playbackRate = nextRate;
  if (!p.paused && !pendingPlay && (forcePlay || player.paused)) {
    suppressUntil = performance.now() + 1000;
    const playbackSource = loadedStream;
    const attempt = {}; pendingPlay = attempt;
    const finished = () => { if (pendingPlay === attempt) pendingPlay = null; };
    const rejected = error => {
      if (pendingPlay !== attempt) return;
      finished();
      if (loadedStream !== playbackSource || !syncEnabled) return;
      lastPlaybackError = ['AbortError', 'NotAllowedError', 'NotSupportedError'].includes(error?.name) ? error.name : 'play_failed';
      // pause(), load() or newer host commands can legitimately interrupt play.
      if (error?.name === 'AbortError') return;
      if (error?.name === 'NotSupportedError') {
        failVideo('Der Browser unterstützt diese Videoquelle oder ihre Codecs nicht. Bitte eine andere kompatible eigene Quelle laden.', 'NotSupportedError'); return;
      }
      syncEnabled = false; presence();
      $('resync').textContent = 'Party-Zeit aktualisieren';
      const message = error?.name === 'NotAllowedError'
        ? 'Der Browser hat den Wiedergabestart blockiert. Bitte „Party-Zeit aktualisieren“ erneut selbst anklicken.'
        : 'Wiedergabestart fehlgeschlagen. Bitte erneut synchronisieren; bei wiederholtem Fehler eine andere kompatible Quelle laden.';
      if (personalHls.active) $('personalHlsStatus').textContent = message;
      status(message, true);
    };
    try { Promise.resolve(player.play()).then(() => {
      if (pendingPlay !== attempt) return;
      finished(); if (loadedStream === playbackSource) presence();
    }, rejected); }
    catch (error) { rejected(error); }
  }
}
function failVideo(message, errorCode = 'media_error') {
  lastPlaybackError = errorCode;
  pendingSeek = internalHlsSeek = pendingPlay = null;
  waitingForTarget = false;
  lastAlignedPlayback = null;
  resetSyncState(); renderQuality(null);
  if (personalHls.active) $('personalHlsStatus').textContent = message;
  personalHls.dispose();
  if (hls) { hls.destroy(); hls = null; }
  syncEnabled = false; loading = false; loadedStream = null; buffering = false;
  pauseLocally(); player.removeAttribute('src'); player.load();
  $('noStream').hidden = false; $('resync').disabled = true;
  if (personalHls.active) $('noStream').textContent = 'Die persönliche HLS-Quelle konnte nicht verwendet werden. Details stehen oben.';
  $('loadStream').hidden = !selectedStream;
  presence(); status(message, true);
}
function resetSyncState() {
  stallTracker.reset(); seekLead.reset();
  nudging = false; lastCorrectiveSeekAt = -Infinity; seekSettled = true; leadSeekStartedAt = null;
  bufferingEvents = 0; segmentStats = {loadMs: null, durationS: null};
  pendingCommand = queuedCommand = null; userSeekPending = false;
  startAfterLoad = false;
}
// Playback resumed after a corrective seek: learn the real recovery delay.
function mediaResumed() {
  if (leadSeekStartedAt != null) { seekLead.observe(performance.now() - leadSeekStartedAt); leadSeekStartedAt = null; }
  seekSettled = true;
}
const currentHls = () => hls || personalHls.instance;
// Listens only for level lists and fragment timing; never reads URLs.
function watchHlsInstance(instance) {
  instance.on(Hls.Events.MANIFEST_PARSED, () => { if (currentHls() === instance) renderQuality(instance); });
  instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (currentHls() === instance) renderSubtitles(); });
  // Shows the variant actually playing, so a manual choice is verifiable.
  instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    if (currentHls() !== instance || qualityOptions(instance.levels).length === 0) return;
    const height = Number(instance.levels?.[data?.level]?.height);
    $('qualityNote').textContent = Number.isInteger(height) && height > 0 ? `Aktiv: ${height >= 2000 ? '4K' : height + 'p'}` : '';
    $('qualityNote').hidden = !$('qualityNote').textContent;
  });
  instance.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    const loading = data?.frag?.stats?.loading, duration = Number(data?.frag?.duration);
    if (currentHls() !== instance || !loading) return;
    const loadMs = Number(loading.end) - Number(loading.start);
    segmentStats = {loadMs: Number.isFinite(loadMs) && loadMs >= 0 ? Math.round(loadMs) : null, durationS: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null};
  });
}
// Real variants only (Auto + distinct heights). A selector without effect is
// never shown: one variant → fixed "Automatisch" note; native Safari HLS →
// the browser chooses. No resolutions are invented.
function renderQuality(instance, nativeHls = false) {
  const options = instance ? qualityOptions(instance.levels) : [];
  const select = $('quality');
  select.replaceChildren(...options.map(({value, label}) => {
    const option = document.createElement('option');
    option.value = String(value); option.textContent = label; return option;
  }));
  select.value = '-1';
  $('qualityWrap').hidden = options.length === 0;
  const torbox = loadedStream?.name === 'TorBox HLS';
  $('qualityNote').textContent = options.length ? ''
    : instance ? (torbox ? 'Automatisch · TorBox liefert eine Qualität' : 'Automatisch · eine Qualität verfügbar')
    : nativeHls ? 'Automatisch · vom Browser gewählt' : '';
  $('qualityNote').hidden = !$('qualityNote').textContent;
}
$('quality').addEventListener('change', () => {
  const instance = currentHls(), level = Number($('quality').value);
  // nextLevel replaces the buffered-ahead fragments, so a manual choice is
  // visible within seconds (loadLevel could take a full 30 s buffer).
  if (instance && qualityOptions(instance.levels).some(option => option.value === level)) instance.nextLevel = level;
});
// --- Subtitles ----------------------------------------------------------------
// Only real sources: hls.js subtitle renditions (EXT-X-MEDIA TYPE=SUBTITLES),
// native text tracks (Safari HLS) and a local .vtt/.srt file chosen by the
// viewer. Files stay in this browser (blob: URL), nothing is uploaded or shared.
let subtitleFiles = [], activeSubtitle = 'off';
const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;
function sourceSubtitles() {
  const instance = currentHls();
  if (instance) return (instance.subtitleTracks || []).map((track, index) => ({id: `hls:${index}`, label: track.name || track.lang || `Untertitel ${index + 1}`}));
  const options = [], tracks = player.textTracks || [], ownTracks = subtitleFiles.map(file => file.element.track);
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (['subtitles', 'captions'].includes(track.kind) && !ownTracks.includes(track)) options.push({id: `native:${i}`, label: track.label || track.language || `Untertitel ${i + 1}`});
  }
  return options;
}
function renderSubtitles() {
  const menu = $('subtitleMenu'), sources = sourceSubtitles();
  const item = (id, label) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.setAttribute?.('role', 'menuitemradio'); button.setAttribute?.('aria-checked', String(activeSubtitle === id));
    button.addEventListener('click', () => { selectSubtitle(id); closeSubtitleMenu(); });
    return button;
  };
  const note = document.createElement('p'); note.className = 'menu-note';
  note.textContent = sources.length || subtitleFiles.length ? 'Untertitel' : 'Diese Quelle liefert keine Untertitel.';
  const load = document.createElement('button'); load.type = 'button'; load.textContent = 'Untertiteldatei laden (.vtt/.srt) …';
  load.addEventListener('click', () => { closeSubtitleMenu(); $('subtitleFile').click?.(); });
  menu.replaceChildren(note, item('off', 'Aus'), ...sources.map(s => item(s.id, s.label)),
    ...subtitleFiles.map((file, index) => item(`file:${index}`, file.label)), load);
}
function selectSubtitle(id) {
  activeSubtitle = id;
  const instance = currentHls();
  if (instance && 'subtitleTrack' in instance) {
    instance.subtitleTrack = id.startsWith('hls:') ? Number(id.slice(4)) : -1;
    instance.subtitleDisplay = id.startsWith('hls:');
  }
  const tracks = player.textTracks || [];
  for (let i = 0; i < tracks.length; i++) {
    const own = subtitleFiles.findIndex(file => file.element.track === tracks[i]);
    if (own >= 0) tracks[i].mode = id === `file:${own}` ? 'showing' : 'disabled';
    else if (!instance && ['subtitles', 'captions'].includes(tracks[i].kind)) tracks[i].mode = id === `native:${i}` ? 'showing' : 'disabled';
  }
  renderSubtitles();
}
// SRT → WebVTT: header plus "," → "." in timestamps; cue text stays text.
function srtToVtt(text) {
  return 'WEBVTT\n\n' + String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
async function addSubtitleFile(file) {
  if (!file) return;
  if (file.size > SUBTITLE_MAX_BYTES) return status('Die Untertiteldatei ist zu groß (max. 2 MB).', true);
  const name = String(file.name || 'Untertitel');
  if (!/\.(vtt|srt)$/i.test(name)) return status('Bitte eine .vtt- oder .srt-Datei wählen.', true);
  let text;
  try { text = await file.text(); } catch { return status('Die Untertiteldatei konnte nicht gelesen werden.', true); }
  const vtt = /\.srt$/i.test(name) ? srtToVtt(text) : text;
  if (!/^﻿?WEBVTT/.test(vtt)) return status('Die Datei ist keine gültige WebVTT-Datei.', true);
  const url = URL.createObjectURL(new Blob([vtt], {type: 'text/vtt'}));
  const element = document.createElement('track');
  element.kind = 'subtitles'; element.label = name.replace(/\.(vtt|srt)$/i, '').slice(0, 60); element.src = url;
  player.append(element);
  subtitleFiles.push({label: element.label, element, url});
  selectSubtitle(`file:${subtitleFiles.length - 1}`);
  status('Untertitel geladen. Sie gelten nur in diesem Browser.');
}
function clearSubtitles() {
  for (const file of subtitleFiles) { file.element.remove?.(); try { URL.revokeObjectURL(file.url); } catch { /* Already released. */ } }
  subtitleFiles = []; activeSubtitle = 'off';
  renderSubtitles();
}
function closeSubtitleMenu() { $('subtitleMenu').hidden = true; $('ctlSubtitles').setAttribute?.('aria-expanded', 'false'); }
$('ctlSubtitles').addEventListener('click', () => {
  const open = $('subtitleMenu').hidden;
  if (open) renderSubtitles();
  $('subtitleMenu').hidden = !open; $('ctlSubtitles').setAttribute?.('aria-expanded', String(open));
});
$('subtitleFile').addEventListener('change', () => {
  const file = $('subtitleFile').files?.[0];
  $('subtitleFile').value = '';
  addSubtitleFile(file);
});
const guestControl = () => guestControlEnabled && session?.canControl() === true;
// Fixed labels for local diagnosis of why shared control is unavailable.
function controlBlockedReason() {
  const room = session?.room;
  if (!guestControlEnabled) return 'disabled_in_build';
  if (!room) return 'no_room';
  if (room.info.host_member_id === room.memberId) return 'is_host';
  if (room.info.host_only === true) return 'host_only';
  if (room.info.host_only !== false) return 'host_only_missing';
  if (!session.channel) return 'no_channel';
  return 'allowed';
}
function renderControlInfo() {
  const info = session?.room?.info, allowed = guestControl();
  $('controlInfo').textContent = !info ? 'Steuerung: nur der Host.'
    : !guestControlEnabled ? 'Steuerung: Play/Pause und Springen steuert der Desktop-Host. Gemeinsame Browsersteuerung ist in dieser Version ausgeschaltet. Lokale Bedienung trennt dich von der Party-Zeit.'
    : allowed ? (guestControlMode === 'confirmed'
      ? 'Steuerung: Play, Pause und Springen im Player gelten für alle (vom Host erlaubt). Jeder Befehl wird zuerst vom Backend bestätigt.'
      : 'Steuerung: Play, Pause und Springen im Player gelten für alle (vom Host erlaubt), wie bei Desktop-Gästen.')
    : info.host_only === false ? 'Steuerung: Gaststeuerung erlaubt, Realtime-Kanal aber noch nicht verbunden.'
    : 'Steuerung: nur der Host. Lokale Bedienung trennt dich von der Party-Zeit.';
  renderPlayerUi();
}

// --- Player controls -------------------------------------------------------
// Own controls instead of native ones (reliable on mobile). They only mark a
// user gesture and call the media element: the existing pause/seeking/play
// listeners then decide between a shared command (guest control allowed) and
// local-only operation. No separate party buttons.
let seekDragging = false, controlsTimer = null, lastPointerType = 'mouse', startAfterLoad = false;
function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const s = Math.floor(value), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function markGesture() { mediaGestureUntil = performance.now() + 1500; }
function renderPlayerUi() {
  const wrap = $('playerWrap'), playing = !player.paused, duration = player.duration;
  setClass(wrap, 'is-playing', playing); setClass(wrap, 'is-paused', !playing); setClass(wrap, 'is-muted', player.muted === true);
  $('ctlPlay').setAttribute?.('aria-label', playing ? 'Pause' : 'Abspielen');
  $('ctlMute').setAttribute?.('aria-label', player.muted ? 'Ton an' : 'Ton aus');
  const seekable = !!loadedStream && Number.isFinite(duration) && duration > 0;
  if (!seekDragging) {
    const value = seekable ? Math.round(player.currentTime / duration * 1000) : 0;
    $('ctlSeek').value = String(value); $('ctlSeek').style.setProperty?.('--fill', `${value / 10}%`);
    $('ctlRemaining').textContent = seekable ? formatTime(duration - player.currentTime) : '0:00';
  }
  $('ctlSeek').disabled = !seekable;
  for (const id of ['ctlBack10', 'ctlFwd10']) $(id).disabled = !seekable;
  // Badge states come only from the real sync/connection state.
  const [label, tone] = connectionLost && session?.room ? ['Verbindung unterbrochen', 'lost']
    : !syncEnabled ? ['Nicht synchron', 'off'] : buffering || waitingForTarget ? ['Puffert …', 'warn'] : ['Synchron', ''];
  $('syncChip').hidden = !loadedStream;
  $('syncChip').textContent = label; $('syncChip').className = tone ? `sync-chip ${tone}` : 'sync-chip';
}
function revealControls() {
  const wrap = $('playerWrap');
  setClass(wrap, 'show-controls', true);
  globalThis.clearTimeout?.(controlsTimer);
  controlsTimer = setTimeout(() => setClass(wrap, 'show-controls', false), 2800);
}
function hideControls() { globalThis.clearTimeout?.(controlsTimer); setClass($('playerWrap'), 'show-controls', false); }
// Big centre button: loading the shared stream is the explicit consent step
// (IP disclosure to the media host); playback then starts automatically.
function startStream() { startAfterLoad = true; loadStream(); }
// play() inside the click gesture; a blocked or failed start is reported,
// never silently ignored.
function playLocally() {
  markGesture();
  Promise.resolve(player.play()).catch(error => {
    if (error?.name === 'AbortError') return;
    lastPlaybackError = error?.name === 'NotAllowedError' ? 'NotAllowedError' : 'play_failed';
    status(error?.name === 'NotAllowedError' ? 'Der Browser hat den Start blockiert. Bitte noch einmal auf Play tippen.' : 'Die Wiedergabe konnte nicht starten. Bitte erneut versuchen.', true);
  });
}
function togglePlay() {
  if (!loadedStream) {
    if (selectedStream && !$('loadStream').hidden) startStream();
    else status('Noch kein Stream freigegeben. Der Host muss „Share my stream“ aktivieren.');
    return;
  }
  if (!player.paused) { markGesture(); player.pause(); return; }
  const party = effectivePlayback();
  // Back into a running party: start in sync instead of at the old position.
  if (!syncEnabled && party && !party.paused && !$('resync').disabled) { resyncNow(); return; }
  if (player.readyState < 1) { status('Die Quelle lädt noch. Gleich geht es los.'); return; }
  playLocally();
}
function skip(seconds) {
  const duration = player.duration;
  if (!loadedStream || !Number.isFinite(duration)) return;
  markGesture();
  player.currentTime = Math.max(0, Math.min(duration - .1, player.currentTime + seconds));
  renderPlayerUi(); revealControls();
}
function toggleFullscreen() {
  const wrap = $('playerWrap');
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  if (wrap.requestFullscreen) Promise.resolve(wrap.requestFullscreen()).catch(() => {});
  else player.webkitEnterFullscreen?.(); // iOS Safari: native fullscreen player.
}
function openDrawer(section = 'info') {
  if (document.fullscreenElement) document.exitFullscreen?.(); // The drawer lives outside the player.
  $('infoDrawer').hidden = false; $('drawerScrim').hidden = false;
  $('membersButton').setAttribute?.('aria-expanded', 'true');
  if (section === 'chat') { $('chatPanel').open = true; $('chatText').focus?.(); }
  else $('drawerClose').focus?.();
}
function closeDrawer() {
  $('infoDrawer').hidden = true; $('drawerScrim').hidden = true;
  $('membersButton').setAttribute?.('aria-expanded', 'false');
}
// Back arrow: to the invitation without leaving the party. Local playback
// pauses; "Zurück zur Party" re-joins the party time.
function backToInvite() {
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  if (syncEnabled) { syncEnabled = false; pauseLocally(); presence(); }
  else if (!player.paused) pauseLocally();
  showPanel('join');
}
player.controls = false;
setClass($('playerWrap'), 'custom-controls', true);
$('ctlPlay').addEventListener('click', togglePlay);
$('ctlBack10').addEventListener('click', () => skip(-10));
$('ctlFwd10').addEventListener('click', () => skip(10));
$('ctlFullscreen').addEventListener('click', toggleFullscreen);
$('ctlBack').addEventListener('click', backToInvite);
$('ctlChat').addEventListener('click', () => openDrawer('chat'));
$('membersButton').addEventListener('click', () => openDrawer('info'));
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerScrim').addEventListener('click', closeDrawer);
$('ctlMute').addEventListener('click', () => { player.muted = !player.muted; renderPlayerUi(); });
$('ctlVolume').addEventListener('input', () => { player.volume = Number($('ctlVolume').value); player.muted = player.volume === 0; renderPlayerUi(); });
$('ctlSeek').addEventListener('input', () => {
  seekDragging = true;
  const duration = player.duration, value = Number($('ctlSeek').value);
  $('ctlSeek').style.setProperty?.('--fill', `${value / 10}%`);
  $('ctlRemaining').textContent = formatTime(duration - duration * value / 1000);
});
$('ctlSeek').addEventListener('change', () => {
  seekDragging = false;
  const duration = player.duration;
  if (!loadedStream || !Number.isFinite(duration)) return;
  markGesture();
  player.currentTime = duration * Number($('ctlSeek').value) / 1000;
  renderPlayerUi();
});
// Mouse: movement reveals, click on the picture toggles playback.
// Touch: a tap on the picture shows or hides the controls (no double-tap logic).
let controlsShownAtPointer = false;
$('playerWrap').addEventListener('pointerdown', e => {
  lastPointerType = e.pointerType || 'mouse';
  controlsShownAtPointer = String($('playerWrap').className || '').includes('show-controls');
  if (lastPointerType === 'mouse' || e.target?.closest?.('.controls-bar, .player-top')) revealControls();
});
$('playerWrap').addEventListener('pointermove', e => { if ((e.pointerType || 'mouse') === 'mouse') revealControls(); });
$('playerWrap').addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'BUTTON'].includes(e.target?.tagName)) return;
  revealControls();
  if (e.key === ' ' || e.key === 'k' || e.key === 'K') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') skip(-10);
  else if (e.key === 'ArrowRight') skip(10);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'm' || e.key === 'M') { player.muted = !player.muted; renderPlayerUi(); }
});
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('infoDrawer').hidden) closeDrawer(); });
player.addEventListener('click', () => {
  if (lastPointerType === 'mouse') togglePlay();
  else if (controlsShownAtPointer) hideControls(); else revealControls();
});
for (const event of ['timeupdate', 'play', 'pause', 'durationchange', 'volumechange', 'emptied']) player.addEventListener(event, () => renderPlayerUi());
// Local user gesture → shared command. Coalesced: one RPC in flight, the
// latest gesture queued. Confirmed states arrive via acceptPlayback.
function sendControl(paused, seconds) {
  if (!guestControl()) return false;
  const request = {paused, seconds};
  if (pendingCommand) { queuedCommand = request; return true; }
  let command;
  try { command = session.prepareControl({paused, positionMs: seconds * 1000}); }
  catch { return false; }
  pendingCommand = command;
  applySync();
  session.commitControl(command, {mode: guestControlMode}).then(() => {
    if (pendingCommand !== command) return;
    pendingCommand = null;
    status(paused ? 'Pause für alle.' : 'Wiedergabe für alle.');
  }, error => {
    if (pendingCommand !== command) return;
    pendingCommand = null; queuedCommand = null;
    status(error?.code === 'host_only' ? 'Der Host hat die Gaststeuerung deaktiviert. Party-Zeit wird wieder übernommen.'
      : error?.code === 'not_confirmed' ? 'Das Backend hat den Steuerbefehl nicht bestätigt. Party-Zeit wird beibehalten.'
      : error?.code === 'closed' ? 'Party-Verbindung geschlossen.'
      : error?.code === 'broadcast_failed' ? 'Steuerbefehl konnte nicht an die Party gesendet werden. Verbindung prüfen.'
      : 'Steuerbefehl nicht gesendet: ' + friendlyError(error), true);
    renderControlInfo();
  }).finally(() => {
    if (pendingCommand || !queuedCommand) { applySync(); renderControlInfo(); return; }
    const next = queuedCommand; queuedCommand = null;
    sendControl(next.paused, next.seconds);
  });
  return true;
}
function loadStream() {
  if (personalHls.active) return;
  if (!selectedStream || !session?.room) return;
  const stream = selectedStream, problem = streamProblem(stream);
  if (problem) return status(problem, true);
  if (hls) { hls.destroy(); hls = null; }
  pauseLocally(); player.removeAttribute('src'); player.load();
  loadedStream = stream; loading = true; syncEnabled = false;
  $('resync').disabled = true; $('loadStream').hidden = true;
  status('Quelle wird geladen. Erst nach erfolgreichem Laden ist die Synchronisierung verfügbar.');
  try {
    if (streamIsHls(stream)) {
      if (player.canPlayType('application/vnd.apple.mpegurl') && !Object.keys(stream.headers || {}).length) { player.src = stream.url; renderQuality(null, true); }
      else if (Hls.isSupported()) {
        const instance = new Hls({...HLS_TUNING, debug: false, enableWorker: true, xhrSetup: xhr => {
          xhr.withCredentials = false;
          for (const [name, value] of Object.entries(stream.headers || {})) xhr.setRequestHeader(name, value);
        }});
        hls = instance;
        watchHlsInstance(instance);
        instance.on(Hls.Events.ERROR, (_event, error) => {
          if (personalHls.active || hls !== instance || loadedStream !== stream) return;
          if (!error.fatal && ['bufferSeekOverHole', 'bufferNudgeOnStall'].includes(error.details)) internalHlsSeek = {seconds: player.currentTime};
          if (error.fatal) failVideo(error.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'HLS-Netzwerkfehler: Manifest, Segmente und ggf. Schlüssel benötigen gültige HTTPS-Links und CORS-Freigaben des Medienservers. Auch abgelaufene Links sind möglich.'
            : 'HLS-Medienfehler: Codec, Container oder Verschlüsselung wird vom Browser nicht unterstützt. Eine andere Quelle wählen.');
        });
        instance.loadSource(stream.url); instance.attachMedia(player);
      } else return failVideo('Dieser Browser unterstützt weder natives HLS noch die benötigte Media-Source-Erweiterung.');
    } else player.src = stream.url;
    presence();
  } catch { failVideo('Die Quelle konnte nicht geöffnet werden. HTTPS, Format und Zugriffsrechte prüfen.'); }
}

$('personalHlsForm').addEventListener('submit', e => {
  e.preventDefault();
  const value = $('personalHlsUrl').value.trim();
  // Never place the URL in selectedStream, PartySession, a broadcast or storage.
  $('personalHlsUrl').value = '';
  if (!session?.room) { status('Zuerst als angemeldetes Mitglied einer Party beitreten.', true); return; }
  const media = session.room.info.media;
  const currentMediaKey = media?.meta_type && media?.meta_id ? mediaKey(media) : '';
  const problem = personalHlsUrlProblem(value) || (!currentMediaKey ? 'Die Party hat noch keine gültige Filmkennung. Bitte den Host prüfen und erneut laden.' : '');
  if (problem) { $('personalHlsStatus').textContent = problem; status(problem, true); return; }
  resetVideo();
  loadedStream = {personal: true, media_key: currentMediaKey};
  loading = true;
  $('useDesktopStream').hidden = false;
  $('streamInfo').textContent = 'Persönliche HLS-Quelle gewählt. Desktop-Streammeldungen ersetzen sie nicht. Bei einem Filmwechsel wird sie gelöscht.';
  $('personalHlsStatus').textContent = 'Playlist wird geprüft. Erreichbarkeit allein bestätigt weder Codec, Seek noch Wiedergabe.';
  $('noStream').textContent = 'Persönliche HLS-Playlist wird geprüft …';
  status('Persönliche HLS-Playlist wird geladen und auf VOD geprüft.');
  try {
    const problem = personalHls.open(value, loadedStream.media_key);
    if (problem) failVideo(problem);
  } catch { failVideo('Die persönliche HLS-Quelle konnte nicht geöffnet werden. Bitte Link und Browser-Unterstützung prüfen.'); }
  presence();
});
$('useDesktopStream').addEventListener('click', () => {
  resetVideo(); presence();
  $('streamInfo').textContent = 'Persönliche Quelle gelöscht. Warte auf die aktuelle Desktop-Freigabe.';
  session?.requestState().catch(() => status('Desktop-Freigabe konnte nicht angefragt werden. Verbindung prüfen.', true));
});
for (const event of ['canplay', 'progress', 'durationchange']) player.addEventListener(event, () => updatePersonalHlsReadiness());
window.addEventListener('pagehide', () => {
  $('personalHlsUrl').value = '';
  if (personalHls.active) resetVideo();
});

// The code comes only from the invitation link (/party/<CODE>). Manual entry is
// a visible fallback solely when the link carries no valid code.
$('partyCode').value = partyCodeFromPath(location.pathname);
$('codeFallback').hidden = validCode($('partyCode').value);
$('authBack').addEventListener('click', () => { pendingJoin = false; showPanel('join'); });
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); if (!client) return status(configProblem, true);
  $('loginButton').disabled = true;
  try {
    const {data, error} = await client.auth.signInWithPassword({email: $('email').value.trim(), password: $('password').value});
    if (error) throw error;
    if (!data.user || data.user.is_anonymous) throw new Error('Ein nicht anonymes Konto ist erforderlich.');
    showPanel('join'); preview();
    // Signed in from the invitation: continue straight into the party.
    if (pendingJoin) { pendingJoin = false; status('Angemeldet. Party wird betreten …'); await joinParty(); }
    else status('Angemeldet. Gib deinen Namen ein und klicke auf „Jetzt ansehen“.');
  } catch (err) { status('Anmeldung fehlgeschlagen: ' + friendlyError(err), true); }
  finally { $('password').value = ''; $('loginButton').disabled = false; }
});
function updateInviteLinks() {
  const code = normalizeCode($('partyCode').value), valid = validCode(code);
  $('openInNuvio').hidden = !valid;
  if (valid) $('openInNuvio').href = `https://nuvio.tv/party/${code}`;
}
async function preview() {
  updateInviteLinks();
  if (!client) return;
  if (!validCode($('partyCode').value)) { $('preview').textContent = 'Dieser Link enthält keinen gültigen Party-Code. Bitte den Einladungslink erneut öffnen oder den Party-Code eingeben.'; return; }
  try {
    const p = await callRpc(client, 'watch_party_preview', {p_code: normalizeCode($('partyCode').value)});
    renderInvite(p);
    const max = Number(p?.max_members) || 0;
    $('preview').textContent = max && Number(p?.members) >= max ? 'Diese Party ist voll.' : '';
  } catch (e) {
    // Without access to the preview the invitation stays neutral; never invented.
    $('preview').textContent = e?.code === 'party_not_found' ? 'Diese Party gibt es nicht (mehr). Prüfe den Code.'
      : e?.code === 'party_ended' ? 'Diese Party wurde beendet.'
      : 'Details zur Party werden nach dem Beitritt angezeigt.';
  }
}
$('partyCode').addEventListener('change', preview);
// Name-only join with an anonymous Supabase identity is OFF unless a build
// opts in (VITE_PARTY_GUEST_JOIN=1) after the backend has confirmed that its
// party RPCs/RLS authorize anonymous members. Nuvio Desktop itself requires a
// real account for parties; without confirmation the account login remains.
const guestJoinEnabled = import.meta.env.VITE_PARTY_GUEST_JOIN === '1';
let pendingJoin = false;
async function joinParty() {
  if (!session) return status(configProblem, true);
  // Already a member (came back via the back arrow): return without re-joining.
  if (session.room) {
    showPanel('watch');
    if (loadedStream && !$('resync').disabled) resyncNow();
    return;
  }
  const code = normalizeCode($('partyCode').value);
  if (!validCode(code)) return status('Bitte den sechsstelligen Party-Code aus der Einladung eingeben.', true);
  const rawIndex = $('profileIndex').value.trim();
  const profileIndex = rawIndex === '' ? null : Number(rawIndex);
  if (profileIndex != null && (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 20)) return status('Ungültiger Profilindex.', true);
  const name = $('displayName').value.trim().slice(0, 36) || 'Browser-Gast';
  try { localStorage.setItem('nuvio-party-name', name); } catch { /* Optional convenience only. */ }
  $('joinButton').disabled = true;
  try {
    const {data: {session: auth} = {}} = await client.auth.getSession();
    if (!auth?.user || (auth.user.is_anonymous && !guestJoinEnabled)) {
      if (!guestJoinEnabled) {
        pendingJoin = true; showPanel('auth');
        status('Bitte einmalig mit deinem Nuvio-Konto anmelden. Danach geht es direkt weiter.');
        return;
      }
      status('Gastzugang wird eingerichtet …');
      const {error} = await client.auth.signInAnonymously();
      if (error) { pendingJoin = true; showPanel('auth'); status('Gastzugang ist nicht freigegeben. Bitte mit einem Nuvio-Konto anmelden.', true); return; }
    }
    status('Party wird betreten …');
    await session.join(code, name, profileIndex, {allowAnonymous: guestJoinEnabled});
    status('Beigetreten. Warte auf die Streamfreigabe durch den Desktop-Host.');
  } catch (err) { showPanel('join'); status('Beitritt fehlgeschlagen: ' + friendlyError(err), true); }
  finally { $('joinButton').disabled = false; }
}
$('joinForm').addEventListener('submit', e => { e.preventDefault(); joinParty(); });
$('invitePlay').addEventListener('click', () => {
  if (!$('authSection').hidden) { pendingJoin = true; $('email').focus?.(); return; }
  if (!$('displayName').value.trim()) { $('displayName').focus?.(); status('Gib deinen Namen ein, dann geht es los.'); return; }
  joinParty();
});
$('copyLink').addEventListener('click', () => {
  const code = normalizeCode($('partyCode').value);
  if (!validCode(code)) return status('Kein gültiger Party-Code.', true);
  Promise.resolve(navigator.clipboard?.writeText(`${location.origin}/party/${code}`))
    .then(() => status('Einladungslink kopiert.'), () => status('Kopieren nicht möglich. Bitte den Link aus der Adresszeile teilen.', true));
});
$('loadStream').addEventListener('click', startStream);
function resyncNow() {
  if (!session?.playback) {
    status('Noch kein Playback-Zustand vorhanden. Prüfe den Desktop-Host.');
    session?.requestState().catch(() => status('Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
    return;
  }
  pendingPlay = null; // An explicit retry owns a new start attempt.
  syncEnabled = true;
  session.requestState().catch(() => status('Aktueller Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
  $('resync').textContent = 'Party-Zeit aktualisieren';
  applySync(true); presence(); renderPlayerUi();
  if (syncEnabled && !waitingForTarget && session.playback.paused) status('Der Host hat pausiert. Die Wiedergabe startet, sobald er fortsetzt.');
}
$('resync').addEventListener('click', resyncNow);
player.addEventListener('loadedmetadata', () => {
  if (!loadedStream) return;
  if (personalHls.active) { updatePersonalHlsReadiness(true); return; }
  loading = false; $('noStream').hidden = true; $('resync').disabled = false;
  status('Metadaten geladen. Klicke auf „Party-Zeit aktualisieren“. Codecfehler können erst beim Start sichtbar werden.'); presence();
  // Started via the big play button: follow the party at once. If the
  // browser blocks autoplay, the play button retries within a user gesture.
  if (startAfterLoad) { startAfterLoad = false; resyncNow(); }
});
// Native controls do not identify the origin of a seeking event. Track actual
// control gestures rather than assuming every hls.js currentTime write is a user seek.
player.addEventListener('pointerdown', () => { mediaPointerDown = true; mediaGestureUntil = performance.now() + 1500; });
for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, () => {
  if (mediaPointerDown) { mediaPointerDown = false; mediaGestureUntil = performance.now() + 1500; }
});
window.addEventListener('blur', () => { mediaPointerDown = false; mediaGestureUntil = -1; });
player.addEventListener('keydown', e => {
  if ([' ', 'Spacebar', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) mediaGestureUntil = performance.now() + 1500;
});
for (const event of ['pause', 'seeking', 'ratechange']) player.addEventListener(event, () => {
  if (event === 'pause' && expectedPauses > 0) { expectedPauses--; return; }
  if (!syncEnabled) return;
  const userControl = mediaPointerDown || performance.now() <= mediaGestureUntil;
  const hlsPlayback = personalHls.active || !!hls || (loadedStream && streamIsHls(loadedStream));
  if (event === 'seeking') {
    const matches = seek => seek && Math.abs(player.currentTime - seek.seconds) < .05;
    const internal = matches(internalHlsSeek);
    if (matches(pendingSeek) || internal) { presence(); return; }
    if (hlsPlayback && !userControl) { presence(); return; }
  } else if (!userControl && hlsPlayback && (buffering || waitingForTarget || player.seeking || player.readyState < 3)) return;
  else if (!userControl && !hlsPlayback && performance.now() <= suppressUntil) return;
  // Rate correction is applied by us on every sync tick.
  if (event === 'ratechange') return;
  // Host allowed guest control: a real gesture becomes a shared command
  // instead of leaving the party. Programmatic pauses/seeks never reach here.
  if (userControl && guestControl()) {
    if (event === 'pause') { sendControl(true, player.currentTime); return; }
    if (event === 'seeking') { userSeekPending = true; return; }
  }
  syncEnabled = false; $('resync').textContent = 'Party-Zeit aktualisieren';
  pendingPlay = null;
  pendingSeek = internalHlsSeek = null;
  mediaPointerDown = false; mediaGestureUntil = -1;
  status('Lokal pausiert oder gespult. Zum Anschluss an die Party erneut synchronisieren.'); presence(); renderPlayerUi();
});
player.addEventListener('seeked', () => {
  pendingSeek = internalHlsSeek = null;
  // seeked = target position decodable; also the end of a seek's load delay.
  if (!buffering) mediaResumed();
  if (userSeekPending) {
    userSeekPending = false;
    const p = effectivePlayback();
    if (syncEnabled && sendControl(p?.paused ?? player.paused, player.currentTime)) { presence(); return; }
  }
  applySync(); presence();
});
// Guest presses play while the party is paused: shared resume, if allowed.
// Our own play() attempts (pendingPlay) are never echoed as commands.
player.addEventListener('play', () => {
  if (!syncEnabled || pendingPlay) return;
  const userControl = mediaPointerDown || performance.now() <= mediaGestureUntil;
  if (!userControl || !effectivePlayback()?.paused) return;
  if (sendControl(false, player.currentTime)) return;
  // Shared control not available: playing locally is allowed, but honestly
  // marked as "Nicht synchron" instead of pretending the party started.
  syncEnabled = false; pendingPlay = null;
  status('Die Party ist pausiert – du schaust lokal weiter. „Party-Zeit aktualisieren“ holt dich zurück.');
  presence(); renderPlayerUi();
});
// load() cancels old media tasks; their pause events may never be delivered.
player.addEventListener('emptied', () => { expectedPauses = 0; });
player.addEventListener('waiting', () => { if (!buffering) bufferingEvents++; buffering = true; presence(); });
player.addEventListener('playing', () => { buffering = false; mediaResumed(); applySync(); presence(); });
player.addEventListener('canplay', () => { buffering = false; mediaResumed(); applySync(); presence(); });
player.addEventListener('error', () => { if (loadedStream && player.error) failVideo('Video nicht abspielbar: möglicher Codec-/Containerfehler, CORS, DRM, abgelaufener Link oder fehlende Zugriffsrechte. Der Browser nennt die Ursache häufig nicht genauer.'); });
function renderSyncDebug() {
  if (!debugEnabled) return;
  if (!debugOutput) {
    const details = document.createElement('details'), title = document.createElement('summary');
    title.textContent = 'Lokale Sync-Diagnose (ohne URLs oder Tokens)';
    debugOutput = document.createElement('pre'); details.append(title, debugOutput);
    $('watchSection').append(details);
  }
  const d = session?.diagnostics || {}, p = session?.playback;
  const number = value => Number.isFinite(value) ? value : null;
  const choice = (value, allowed) => allowed.includes(value) ? value : null;
  const hostPosition = p ? expectedPositionMs(p, session.now()) / 1000 : null;
  debugOutput.textContent = JSON.stringify({
    realtime: choice(d.connection, ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'CONNECTING']),
    realtimeStateCount: number(d.realtimeStates), snapshotStateCount: number(d.snapshotStates),
    lastRealtimeStateAt: number(d.lastRealtimeAt), lastAcceptedAt: number(d.lastAcceptedAt),
    acceptedSource: choice(d.acceptedSource, ['realtime', 'snapshot', 'command']),
    lastEventSource: choice(d.lastSource, ['realtime', 'snapshot', 'command']),
    realtimeLatencyMs: number(d.realtimeLatencyMs),
    lastDecision: choice(d.lastDecision, ['no_room', 'invalid_playback', 'wrong_media', 'not_host', 'not_newer', 'accepted']),
    lastCandidateSeq: number(d.candidateSeq), playbackSeq: number(p?.seq),
    hostPaused: typeof p?.paused === 'boolean' ? p.paused : null, hostWaiting: p?.waiting === true,
    hostPositionSeconds: number(hostPosition), browserPositionSeconds: number(player.currentTime),
    driftSeconds: p ? number(player.currentTime - hostPosition) : null,
    syncActive: syncEnabled, buffering, waitingForTarget, seeking: player.seeking === true,
    browserPaused: player.paused === true, playPending: !!pendingPlay,
    lastPlaybackError: choice(lastPlaybackError, ['none', 'AbortError', 'NotAllowedError', 'NotSupportedError', 'play_failed', 'seek_failed', 'hls_error', 'media_error']),
    // Media/network quality: numbers and fixed labels only, never URLs.
    playbackMode: !loadedStream ? null : currentHls() ? 'hls.js' : streamIsHls(loadedStream) ? 'native-hls' : 'progressive',
    videoWidth: number(player.videoWidth), videoHeight: number(player.videoHeight),
    bandwidthKbps: currentHls() && Number.isFinite(currentHls().bandwidthEstimate) ? Math.round(currentHls().bandwidthEstimate / 1000) : null,
    qualityVariants: currentHls() ? number(currentHls().levels?.length) : null,
    bufferAheadSeconds: number(Math.round(bufferAhead(bufferedRanges(player.buffered), player.currentTime) * 10) / 10),
    lastSegmentLoadMs: number(segmentStats.loadMs), lastSegmentDurationSeconds: number(segmentStats.durationS),
    bufferingEvents: number(bufferingEvents), stallsSinceLoad: number(stallTracker.stalls),
    partyWaitsInWindow: number(stallTracker.waits.length), selfCatchUp: stallTracker.selfCatchUp === true,
    seekLeadSeconds: number(Math.round(seekLead.seconds * 100) / 100), rateNudging: nudging,
    playbackRate: number(player.playbackRate),
    guestControl: guestControl(), controlBlockedReason: controlBlockedReason(), commandPending: !!pendingCommand,
    commandsSent: number(d.commands),
    lastCommandResult: choice(d.lastCommandResult, ['confirmed', 'stored_not_broadcast', 'broadcast', 'persisted', 'persist_failed', 'broadcast_failed', 'host_only', 'not_confirmed', 'closed', 'rpc_failed']),
  }, null, 2);
}
setInterval(() => { applySync(); presence(); renderControlInfo(); renderSyncDebug(); }, 1000);
$('leaveButton').addEventListener('click', async () => { await session?.close(); showPanel('join'); status('Party verlassen.'); });
$('logoutButton').addEventListener('click', async () => { await session?.close(); await client?.auth.signOut(); showPanel('auth'); status('Abgemeldet.'); });
$('chatForm').addEventListener('submit', async e => {
  e.preventDefault(); const body = $('chatText').value.trim();
  if (!session?.room || !body) return;
  if (!pendingChat || pendingChat.body !== body) pendingChat = {body, id: crypto.randomUUID()};
  const pending = pendingChat, room = session.room;
  const button = $('chatForm').querySelector('button'); button.disabled = true;
  try {
    await session.sendMessage(body, pending.id);
    if (room === session.room) { $('chatText').value = ''; pendingChat = null; }
  } catch (err) { status('Nachricht nicht bestätigt. Erneut senden verwendet dieselbe Nachrichtenkennung: ' + friendlyError(err), true); }
  finally { button.disabled = false; }
});
client?.auth.onAuthStateChange((event, authSession) => {
  // Avoid awaited Supabase calls inside the auth callback (SDK lock).
  if (event === 'SIGNED_OUT') setTimeout(async () => { await session.close(false); showPanel('auth'); status('Sitzung beendet. Bitte erneut anmelden.'); }, 0);
});
(async () => {
  if (!client) { showPanel('auth'); $('loginButton').disabled = true; status(configProblem, true); return; }
  try {
    try { $('displayName').value = localStorage.getItem('nuvio-party-name') || ''; } catch { /* Optional. */ }
    const {error} = await client.auth.getSession();
    if (error) throw error;
    // Name + "Jetzt ansehen" first; joinParty() opens the one-time account
    // step only when no usable session exists.
    showPanel('join');
    await preview();
  } catch (e) { showPanel('auth'); status(friendlyError(e), true); }
})();
