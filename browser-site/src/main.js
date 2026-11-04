import {createClient} from '@supabase/supabase-js';
import Hls from 'hls.js';
import './style.css';
import {normalizeCode, validCode, partyCodeFromPath, mediaKey, expectedPositionMs, streamProblem, streamIsHls, browserPartyStream, publicConfigProblem} from './protocol.js';
import {PartySession, callRpc} from './session.js';
import {PersonalHlsSource, personalHlsUrlProblem} from './personal-hls.js';

const $ = id => document.getElementById(id);
const player = $('player');
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
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
let lastAlignedPlayback = null, bufferingSince = null;
let presenceRoom = null, lastPresence = null;
let expectedPauses = 0, mediaPointerDown = false, mediaGestureUntil = -1;
let lastPlaybackError = 'none', debugOutput = null, debugEnabled = false;
try { debugEnabled = sessionStorage.getItem('nuvio-party-debug') === '1'; } catch { /* Local opt-in unavailable. */ }
let personalReadinessMessage = '';
const personalHls = new PersonalHlsSource(Hls, player, {
  onInternalSeek: seconds => { internalHlsSeek = {seconds}; },
  onPlaylist: playlist => {
    $('personalHlsStatus').textContent = playlist.message;
    updatePersonalHlsReadiness(true);
  },
  onError: message => { $('personalHlsStatus').textContent = message; failVideo(message, 'hls_error'); },
});
const session = client ? new PartySession(client, deviceId, {
  room: room => {
    if (personalHls.active && personalHls.mediaKey !== mediaKey(room.info.media)) resetVideo('Filmkennung geändert. Bitte eine eigene Quelle für den neuen Film laden.');
    $('partyLabel').textContent = `PARTY ${room.info.code} · ${room.members.length} Mitglieder`;
    $('movieTitle').textContent = room.info.media?.episode_title || room.info.media?.title || 'Watch Party';
    $('movieInfo').textContent = `Host: ${room.members.find(m => m.id === room.info.host_member_id)?.display_name || 'Unbekannt'} · Bis zu ${room.info.max_members || 3} Personen`;
    showPanel('watch');
  },
  connection: state => {
    $('connection').textContent = state === 'SUBSCRIBED' ? 'Verbunden' : 'Verbindung unterbrochen';
    if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state)) {
      syncEnabled = false;
      pauseLocally();
      $('resync').textContent = 'Wiedergabe synchronisieren';
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
    if (problem) { $('noStream').textContent = 'Quelle empfangen, aber im Browser nicht unterstützt. Details stehen oben.'; status(problem, true); }
    else status('Quelle empfangen. Klicke auf „Freigegebenen Stream laden“.');
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
  closed: () => { resetVideo('Party-Verbindung geschlossen. Persönliche Quelle entfernt.'); $('chatLog').replaceChildren(); pendingChat = null; $('connection').textContent = 'Nicht verbunden'; },
  ended: message => { resetVideo('Party beendet oder Mitgliedschaft verloren. Persönliche Quelle entfernt.'); showPanel('join'); status(message); },
}) : null;

function status(message, error = false) {
  $('message').textContent = message;
  $('message').style.borderColor = error ? '#ff6969' : '#ec896c';
}
function showPanel(name) {
  for (const panel of ['auth', 'join', 'watch']) $(panel + 'Section').hidden = panel !== name;
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
  lastAlignedPlayback = null; bufferingSince = null; lastPresence = null;
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
  $('resync').disabled = true; $('resync').textContent = 'Wiedergabe synchronisieren';
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
  // Like Desktop, only report sustained media starvation. A play promise or a
  // routine seek is not itself a reason for the coordinator to pause everyone.
  if (buffering || waitingForTarget) bufferingSince ??= performance.now();
  else bufferingSince = null;
  const stalled = bufferingSince != null && performance.now() - bufferingSince >= 1000;
  if (loadedStream) state = syncEnabled ? (stalled ? 'buffering' : 'ready') : 'behind';
  // Waiting for consent or an unsupported source must never stall the whole party.
  if (loading) state = syncEnabled ? 'buffering' : 'browsing';
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
function applySync(forcePlay = false) {
  const p = session?.playback;
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
      $('resync').disabled = true; $('resync').textContent = 'Wiedergabe synchronisieren';
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
  const needsSeek = Math.abs(drift) > (p.paused ? .5 : 1.5);
  // Queue the latest accepted command during a native seek. Once seeked fires,
  // apply it immediately, including when the old target was still buffering.
  if (!pendingSeek && !player.seeking && (!buffering || lastAlignedPlayback !== p || forcePlay) && needsSeek) {
    suppressUntil = performance.now() + 1000;
    try {
      pendingSeek = {seconds: desired, at: performance.now()};
      player.currentTime = desired;
      lastAlignedPlayback = p;
    }
    catch {
      pendingSeek = null;
      lastPlaybackError = 'seek_failed';
      syncEnabled = false; pauseLocally(); presence();
      $('resync').textContent = 'Wiedergabe synchronisieren';
      const message = 'Der Browser konnte den Party-Zeitpunkt nicht anspringen. Bitte einen suchbaren VOD-Stream verwenden und erneut synchronisieren.';
      if (personalHls.active) $('personalHlsStatus').textContent = message;
      status(message, true); return;
    }
  }
  if (!needsSeek) lastAlignedPlayback = p;
  const rate = p.rate ?? 1;
  player.playbackRate = !p.paused && Math.abs(drift) > .25 && Math.abs(drift) <= 1.5 ? Math.max(.25, Math.min(4, rate * (drift > 0 ? .95 : 1.05))) : rate;
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
      $('resync').textContent = 'Wiedergabe synchronisieren';
      const message = error?.name === 'NotAllowedError'
        ? 'Der Browser hat den Wiedergabestart blockiert. Bitte „Wiedergabe synchronisieren“ erneut selbst anklicken.'
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
  bufferingSince = null; lastAlignedPlayback = null;
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
      if (player.canPlayType('application/vnd.apple.mpegurl') && !Object.keys(stream.headers || {}).length) player.src = stream.url;
      else if (Hls.isSupported()) {
        const instance = new Hls({debug: false, enableWorker: true, xhrSetup: xhr => {
          xhr.withCredentials = false;
          for (const [name, value] of Object.entries(stream.headers || {})) xhr.setRequestHeader(name, value);
        }});
        hls = instance;
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

$('partyCode').value = partyCodeFromPath(location.pathname);
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); if (!client) return status(configProblem, true);
  $('loginButton').disabled = true;
  try {
    const {data, error} = await client.auth.signInWithPassword({email: $('email').value.trim(), password: $('password').value});
    if (error) throw error;
    if (!data.user || data.user.is_anonymous) throw new Error('Ein nicht anonymes Konto ist erforderlich.');
    showPanel('join'); status('Angemeldet. Du kannst der Party jetzt beitreten.'); await preview();
  } catch (err) { status('Anmeldung fehlgeschlagen: ' + friendlyError(err), true); }
  finally { $('password').value = ''; $('loginButton').disabled = false; }
});
async function preview() {
  if (!client || !validCode($('partyCode').value)) return;
  try {
    const p = await callRpc(client, 'watch_party_preview', {p_code: normalizeCode($('partyCode').value)});
    $('preview').textContent = `${p.media?.title || 'Watch Party'} · Host: ${p.host?.display_name || '–'} · ${p.members}/${p.max_members} Plätze`;
  } catch (e) { $('preview').textContent = 'Vorschau: ' + friendlyError(e); }
}
$('partyCode').addEventListener('change', preview);
$('joinForm').addEventListener('submit', async e => {
  e.preventDefault(); if (!session) return status(configProblem, true);
  const code = normalizeCode($('partyCode').value);
  if (!validCode(code)) return status('Bitte genau sechs gültige Zeichen eingeben.', true);
  const rawIndex = $('profileIndex').value.trim();
  const profileIndex = rawIndex === '' ? null : Number(rawIndex);
  if (profileIndex != null && (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 20)) return status('Ungültiger Profilindex.', true);
  $('joinButton').disabled = true;
  try { await session.join(code, $('displayName').value.trim() || 'Browser-Gast', profileIndex); status('Beigetreten. Warte auf die Streamfreigabe durch den Desktop-Host.'); }
  catch (err) { showPanel('join'); status('Beitritt fehlgeschlagen: ' + friendlyError(err), true); }
  finally { $('joinButton').disabled = false; }
});
$('loadStream').addEventListener('click', loadStream);
$('resync').addEventListener('click', () => {
  if (!session?.playback) {
    status('Noch kein Playback-Zustand vorhanden. Prüfe den Desktop-Host.');
    session?.requestState().catch(() => status('Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
    return;
  }
  pendingPlay = null; // An explicit retry owns a new start attempt.
  syncEnabled = true;
  session.requestState().catch(() => status('Aktueller Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
  $('resync').textContent = personalHls.active ? 'Party-Zeit folgen (erneut ausrichten)' : 'Synchronisiert (erneut ausrichten)';
  applySync(true); presence();
  if (syncEnabled && !waitingForTarget && session.playback.paused) status('Der empfangene Host-Zustand ist pausiert. Warte auf Host-Play; der aktuelle Zustand wurde erneut angefragt.');
});
player.addEventListener('loadedmetadata', () => {
  if (!loadedStream) return;
  if (personalHls.active) { updatePersonalHlsReadiness(true); return; }
  loading = false; $('noStream').hidden = true; $('resync').disabled = false;
  status('Metadaten geladen. Klicke auf „Wiedergabe synchronisieren“. Codecfehler können erst beim Start sichtbar werden.'); presence();
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
  syncEnabled = false; $('resync').textContent = 'Wiedergabe synchronisieren';
  pendingPlay = null;
  pendingSeek = internalHlsSeek = null;
  mediaPointerDown = false; mediaGestureUntil = -1;
  status('Lokal pausiert oder gespult. Zum Anschluss an die Party erneut synchronisieren.'); presence();
});
player.addEventListener('seeked', () => { pendingSeek = internalHlsSeek = null; applySync(); presence(); });
// load() cancels old media tasks; their pause events may never be delivered.
player.addEventListener('emptied', () => { expectedPauses = 0; });
player.addEventListener('waiting', () => { buffering = true; presence(); });
player.addEventListener('playing', () => { buffering = false; applySync(); presence(); });
player.addEventListener('canplay', () => { buffering = false; applySync(); presence(); });
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
    acceptedSource: choice(d.acceptedSource, ['realtime', 'snapshot']),
    lastEventSource: choice(d.lastSource, ['realtime', 'snapshot']),
    lastDecision: choice(d.lastDecision, ['no_room', 'invalid_playback', 'wrong_media', 'not_host', 'not_newer', 'accepted']),
    lastCandidateSeq: number(d.candidateSeq), playbackSeq: number(p?.seq),
    hostPaused: typeof p?.paused === 'boolean' ? p.paused : null, hostWaiting: p?.waiting === true,
    hostPositionSeconds: number(hostPosition), browserPositionSeconds: number(player.currentTime),
    driftSeconds: p ? number(player.currentTime - hostPosition) : null,
    syncActive: syncEnabled, buffering, waitingForTarget, seeking: player.seeking === true,
    browserPaused: player.paused === true, playPending: !!pendingPlay,
    lastPlaybackError: choice(lastPlaybackError, ['none', 'AbortError', 'NotAllowedError', 'NotSupportedError', 'play_failed', 'seek_failed', 'hls_error', 'media_error']),
  }, null, 2);
}
setInterval(() => { applySync(); presence(); renderSyncDebug(); }, 1000);
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
    const {data: {session: auth}, error} = await client.auth.getSession();
    if (error) throw error;
    showPanel(auth?.user && !auth.user.is_anonymous ? 'join' : 'auth');
    if (auth?.user) await preview();
  } catch (e) { showPanel('auth'); status(friendlyError(e), true); }
})();
