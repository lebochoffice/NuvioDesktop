import {createClient} from '@supabase/supabase-js';
import Hls from 'hls.js';
import './style.css';
import {normalizeCode, validCode, partyCodeFromPath, mediaKey, expectedPositionMs, streamProblem, streamIsHls, publicConfigProblem} from './protocol.js';
import {PartySession, callRpc} from './session.js';

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
const session = client ? new PartySession(client, deviceId, {
  room: room => {
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
  playback: () => applySync(),
  stream: stream => {
    if (!stream) {
      resetVideo();
      $('streamInfo').textContent = 'Keine aktive Streamfreigabe. Der Desktop-Host muss „Share my stream“ aktivieren.';
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
  media: () => { resetVideo(); $('streamInfo').textContent = 'Film gewechselt. Warte auf die neue Streamfreigabe.'; },
  chat: message => {
    const line = document.createElement('div'), author = document.createElement('b');
    author.textContent = `${message.name || session.room?.members.find(m => m.id === message.member_id)?.display_name || 'Gast'}: `;
    line.append(author, document.createTextNode(message.body || ''));
    $('chatLog').append(line);
    if ($('chatLog').children.length > 100) $('chatLog').firstChild.remove();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  },
  error: e => status(friendlyError(e), true),
  closed: () => { resetVideo(); $('chatLog').replaceChildren(); pendingChat = null; $('connection').textContent = 'Nicht verbunden'; },
  ended: message => { showPanel('join'); status(message); },
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
function pauseLocally() { suppressUntil = performance.now() + 1000; player.pause(); }
function resetVideo() {
  syncEnabled = false; loading = false; buffering = false;
  selectedStream = loadedStream = null;
  if (hls) { hls.destroy(); hls = null; }
  pauseLocally(); player.removeAttribute('src'); player.load();
  $('noStream').hidden = false; $('loadStream').hidden = true;
  $('noStream').textContent = 'Warte auf eine freigegebene Streamquelle des Hosts …';
  $('resync').disabled = true; $('resync').textContent = 'Wiedergabe synchronisieren';
}
function presence() {
  if (!session?.room) return;
  let state = 'browsing';
  if (loadedStream) state = syncEnabled ? (buffering ? 'buffering' : 'ready') : 'behind';
  // Waiting for consent or an unsupported source must never stall the whole party.
  if (loading) state = 'browsing';
  const gap = session.playback ? Math.max(5000, expectedPositionMs(session.playback, session.now()) - player.currentTime * 1000) : 5000;
  session.sendPresence(state, state === 'behind' ? Math.round(gap) : undefined).catch(e => status('Status nicht gesendet: ' + friendlyError(e), true));
}
function applySync(forcePlay = false) {
  const p = session?.playback;
  if (!syncEnabled || !p || !loadedStream || player.readyState < 1) return;
  let desired = expectedPositionMs(p, session.now()) / 1000;
  if (Number.isFinite(player.duration)) desired = Math.max(0, Math.min(Math.max(0, player.duration - .1), desired));
  const drift = player.currentTime - desired;
  if (Math.abs(drift) > (p.paused ? .5 : 1.5)) {
    suppressUntil = performance.now() + 1000;
    player.currentTime = desired;
  }
  const rate = p.rate ?? 1;
  player.playbackRate = !p.paused && Math.abs(drift) > .25 && Math.abs(drift) <= 1.5 ? Math.max(.25, Math.min(4, rate * (drift > 0 ? .95 : 1.05))) : rate;
  if (p.paused) { if (!player.paused) pauseLocally(); }
  else if (forcePlay || player.paused) {
    suppressUntil = performance.now() + 1000;
    player.play().catch(() => {
      syncEnabled = false; presence();
      $('resync').textContent = 'Wiedergabe synchronisieren';
      status('Der Browser blockiert den Start oder unterstützt das Video nicht. Erneut synchronisieren; bei einem Videofehler eine andere Quelle wählen.', true);
    });
  }
}
function failVideo(message) {
  if (hls) { hls.destroy(); hls = null; }
  syncEnabled = false; loading = false; loadedStream = null; buffering = false;
  pauseLocally(); player.removeAttribute('src'); player.load();
  $('noStream').hidden = false; $('resync').disabled = true;
  $('loadStream').hidden = !selectedStream;
  presence(); status(message, true);
}
function loadStream() {
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
      if (player.canPlayType('application/vnd.apple.mpegurl')) player.src = stream.url;
      else if (Hls.isSupported()) {
        hls = new Hls({enableWorker: true, xhrSetup: xhr => { xhr.withCredentials = false; }});
        hls.on(Hls.Events.ERROR, (_event, error) => {
          if (error.fatal) failVideo(error.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'HLS-Netzwerkfehler: Manifest, Segmente und ggf. Schlüssel benötigen gültige HTTPS-Links und CORS-Freigaben des Medienservers. Auch abgelaufene Links sind möglich.'
            : 'HLS-Medienfehler: Codec, Container oder Verschlüsselung wird vom Browser nicht unterstützt. Eine andere Quelle wählen.');
        });
        hls.loadSource(stream.url); hls.attachMedia(player);
      } else return failVideo('Dieser Browser unterstützt weder natives HLS noch die benötigte Media-Source-Erweiterung.');
    } else player.src = stream.url;
    presence();
  } catch { failVideo('Die Quelle konnte nicht geöffnet werden. HTTPS, Format und Zugriffsrechte prüfen.'); }
}

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
  if (!session?.playback) { status('Noch kein Playback-Zustand vorhanden. Prüfe den Desktop-Host.'); session?.requestState(); return; }
  syncEnabled = true; buffering = false; $('resync').textContent = 'Synchronisiert (erneut ausrichten)'; applySync(true); presence();
});
player.addEventListener('loadedmetadata', () => {
  if (!loadedStream) return;
  loading = false; $('noStream').hidden = true; $('resync').disabled = false;
  status('Metadaten geladen. Klicke auf „Wiedergabe synchronisieren“. Codecfehler können erst beim Start sichtbar werden.'); presence();
});
for (const event of ['pause', 'seeking', 'ratechange']) player.addEventListener(event, () => {
  if (!syncEnabled || performance.now() <= suppressUntil) return;
  // Rate correction is applied by us on every sync tick.
  if (event === 'ratechange') return;
  syncEnabled = false; $('resync').textContent = 'Wiedergabe synchronisieren';
  status('Lokal pausiert oder gespult. Zum Anschluss an die Party erneut synchronisieren.'); presence();
});
player.addEventListener('waiting', () => { buffering = true; presence(); });
player.addEventListener('playing', () => { buffering = false; presence(); });
player.addEventListener('canplay', () => { buffering = false; presence(); });
player.addEventListener('error', () => { if (loadedStream && player.error) failVideo('Video nicht abspielbar: möglicher Codec-/Containerfehler, CORS, DRM, abgelaufener Link oder fehlende Zugriffsrechte. Der Browser nennt die Ursache häufig nicht genauer.'); });
setInterval(() => { applySync(); }, 1000);
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
