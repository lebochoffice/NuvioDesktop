import {createClient} from '@supabase/supabase-js';
import Hls from 'hls.js';
import './style.css';
import {normalizeCode, validCode, partyCodeFromPath, mediaKey, expectedPositionMs, isNewerPlayback, streamProblem, streamIsHls, browserPartyStream, publicConfigProblem, memberSync, memberSyncLabel, shareWorkerOrigin, withFamilyToken} from './protocol.js';
import {PartySession, callRpc} from './session.js';
import {PersonalHlsSource, personalHlsUrlProblem} from './personal-hls.js';
import {loadRoomTitle, resolveRoomMedia, roomMediaForEpisode, searchRoomMedia} from './room-media.js';
import {classifyShareLink, familyHlsRequest, hostShareStream, proposalFrom} from './host-share.js';
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
// Browser-host video sharing and link proposals (Phase 2) are LOCKED by default:
// the backend cannot authenticate who sent a realtime stream offer, state or
// proposal (member_id is claimed by the client), proposals are readable by every
// member, and a shared source has no server-confirmed revision. See
// PARTY_ROOM_PHASE2.md, "Sicherheitsstatus". Only for closed internal tests:
// VITE_PARTY_BROWSER_HOST_SHARE=1.
const browserHostShareEnabled = String(import.meta.env.VITE_PARTY_BROWSER_HOST_SHARE ?? '').trim() === '1';
// Optional family share Worker: hands the host's TorBox address (with account
// token) only to members the host admitted. Memory only, never stored/logged.
const SHARE_WORKER = shareWorkerOrigin(import.meta.env.VITE_PARTY_SHARE_WORKER);
let familyGrant = null, familyRequest = 0, familyStream = null;
let countdownRun = 0;
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
// Rejoin after a page reload: only the party code of an active membership is
// kept for this tab (never URLs, tokens or keys). Cleared on leave, sign-out,
// removal and party end, so none of those is undone by a reload.
const JOINED_PARTY_KEY = 'nuvio-party-joined';
const rememberJoinedParty = code => { try { sessionStorage.setItem(JOINED_PARTY_KEY, code); } catch { /* Session only. */ } };
const forgetJoinedParty = () => { try { sessionStorage.removeItem?.(JOINED_PARTY_KEY); sessionStorage.setItem(JOINED_PARTY_KEY, ''); } catch { /* Session only. */ } };
const joinedPartyCode = () => { try { return sessionStorage.getItem(JOINED_PARTY_KEY) || ''; } catch { return ''; } };
let hls = null, selectedStream = null, loadedStream = null, syncEnabled = false;
let suppressUntil = 0, loading = false, buffering = false;
let pendingChat = null;
let pendingSeek = null, internalHlsSeek = null, pendingPlay = null, ownSeek = null;
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
// Personal link: follow the party time automatically once the VOD is ready.
// Bounded retries; never while watching alone, never after the user left sync.
const PERSONAL_AUTO_SYNC_TRIES = 30, PERSONAL_AUTO_SYNC_MS = 1000;
let personalAutoSync = null;
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
    renderMembers(room);
    renderPartyRoom();
    renderControlInfo();
    showPanel('watch');
    if (session.isHost() && hostMenuRoom !== room) {
      hostMenuRoom = room;
      openDrawer('settings', $('membersButton'));
      selectDrawerTab('Host');
    } else if (!session.isHost()) hostMenuRoom = null;
  },
  connection: state => {
    $('roomConnection').textContent = state === 'SUBSCRIBED' ? 'Verbunden'
      : state === 'CONNECTING' ? 'Verbinde …' : 'Verbindung unterbrochen';
    // CONNECTING is transient (initial join or automatic reconnect), not a loss.
    if (state === 'CONNECTING') {
      realtimeReconnecting = connectionLost;
      $('connection').textContent = connectionLost ? 'Verbinde neu …' : 'Verbinde …';
      renderPlayerUi(); return;
    }
    realtimeReconnecting = false;
    connectionLost = state !== 'SUBSCRIBED';
    $('connection').textContent = state === 'SUBSCRIBED' ? 'Verbunden' : 'Verbindung unterbrochen';
    renderPlayerUi();
    if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state)) {
      if (syncEnabled) resumeAfterReconnect = true;
      syncEnabled = false;
      if (!soloMode) pauseLocally(); // Watching alone does not depend on the party.
      status('Realtime-Verbindung unterbrochen. Sie wird automatisch neu aufgebaut; danach folgt die Wiedergabe wieder der Party-Zeit.', true);
    } else if (state === 'SUBSCRIBED' && awaitingHandoff) {
      finishBrowserHandoff();
    } else if (state === 'SUBSCRIBED' && resumeAfterReconnect) {
      // Reconnect restores the authoritative party state (state_request + snapshot).
      resumeAfterReconnect = false;
      resyncNow();
    }
  },
  playback: () => {
    if (awaitingHandoff) { finishBrowserHandoff(); return; }
    updatePersonalHlsReadiness();
    if (awaitingPartyState && loadedStream && !soloMode && session.playback) { awaitingPartyState = false; resyncNow(); }
    applySync(); finishSourceRecovery(); renderSyncDebug();
  },
  sourceRecoveryCandidate: attempt => {
    const offered = browserPartyStream(attempt.offer.stream);
    const validated = hostShareStream(offered?.url, attempt.key, browserHostShareEnabled);
    const source = browserPartyStream(validated.stream);
    if (!source || !!source.family_beta !== !!offered.family_beta || shareBusy || loadedStream || selectedStream) {
      session.failSourceRecovery();
      return;
    }
    recoveringSource = {attempt, stream: validated.stream};
    selectedStream = source;
    $('streamInfo').textContent = 'Die bisherige Videoquelle wird wiederhergestellt …';
    startStream();
  },
  sourceRecoveryCancelled: attempt => {
    if (recoveringSource?.attempt !== attempt) return;
    recoveringSource = null;
    resetVideo();
  },
  sourceRecoveryUnavailable: () => {
    if (!session.isHost() || session.hostOffer) return;
    $('roomShareStatus').textContent = 'Keine eindeutig aktive Videoquelle gefunden. Bitte den Link erneut freigeben.';
    status($('roomShareStatus').textContent);
  },
  command: entry => commandSettled(entry),
  // Browser host only (session checks the host role first).
  proposal: payload => {
    if (!browserHostShareEnabled) return; // Locked: unauthenticated sender, readable by all members.
    const room = session.room, proposal = proposalFrom(payload, room, mediaKey(room?.info.media), browserHostShareEnabled);
    if (!proposal) return;
    const existing = proposals.findIndex(item => item.memberId === proposal.memberId);
    if (existing >= 0) proposals.splice(existing, 1); // One open proposal per member.
    proposals.unshift({...proposal, room, mediaKey: mediaKey(room.info.media), revision: session.hostSourceRevision, id: ++proposalSeq});
    proposals.length = Math.min(proposals.length, 10);
    renderPartyRoom();
    status(`Neuer Videovorschlag von ${proposal.name}. Prüfen und annehmen im Party-Room.`);
  },
  hostCapabilities: () => renderProposalForm(),
  proposalResult: result => {
    if (!session.canSuggestBrowserLink()) return;
    $('suggestStatus').textContent = result === 'accepted' ? 'Der Host hat deinen Vorschlag angenommen.' : 'Der Host hat deinen Vorschlag abgelehnt.';
    status($('suggestStatus').textContent, result !== 'accepted');
  },
  members: () => { if (session?.room) { renderMembers(session.room); renderPartyRoom(); } },
  promoted: inherited => {
    if (!browserHostShareEnabled) return;
    const source = browserPartyStream(inherited?.stream);
    const link = classifyShareLink(source?.url, browserHostShareEnabled);
    // Family links were explicitly shared with this party. Other signed URLs
    // and Desktop grants still need an explicit new share.
    if (!inherited?.playback || soloMode || link.problem ||
        (new URL(link.url).search && !(link.family && source.family_beta))) {
      selectDrawerTab('Party');
      status('Du bist jetzt Host. Gib einen gültigen Videolink für die Party frei.');
      return;
    }
    shareHostVideo(link.url, undefined, inherited.playback);
  },
  stream: (stream, reason) => {
    // A host change is no revocation by the sharing host: an already loaded
    // source continues locally ("Allein"); an explicit revocation (null without
    // reason) still stops it at once.
    if (!stream && reason === 'host_changed') {
      hostShared = null;
      proposals.length = 0;
      pendingCommand = queuedCommand = null;
      lastHostStreamEvent = undefined;
      awaitingHandoff = !soloMode && (syncEnabled || resumeAfterReconnect || awaitingHandoff) && !!loadedStream && !personalHls.active;
      handoffSourceReady = false;
      awaitingPartyState = false;
      resumeAfterReconnect = false;
      if (awaitingHandoff) {
        syncEnabled = false; pendingPlay = pendingSeek = null;
        player.playbackRate = 1;
        presence(); renderPlayerUi();
        status('Synchronisierung wird übernommen …');
      } else if (loadedStream && !personalHls.active) {
        continueLocally('Der Host hat gewechselt. Die bisherige Quelle läuft lokal weiter.');
      } else if (!personalHls.active) resetVideo();
      return;
    }
    if (session?.isHost?.()) return;
    if (stream?.browser_hls?.family_beta_url &&
        (!browserHostShareEnabled || !classifyShareLink(stream.browser_hls.family_beta_url, true).family)) return;
    // Includes revocations, incompatible URLs and host source changes. Only an
    // authoritative media/room lifecycle event clears a personal source.
    if (stream && stream.media_key !== mediaKey(session.room?.info.media)) return;
    const previousOffer = lastHostStreamEvent;
    lastHostStreamEvent = stream; // Memory only, for enabling auto mode later.
    const browserPending = !!stream && Object.hasOwn(stream, 'browser_hls');
    // Optional desktop hint while browser_hls has no URL yet (older hosts send none).
    const browserState = browserPending ? String(stream.browser_hls?.state || 'preparing') : null;
    // Family share: the address comes from the share service, not the broadcast.
    if (browserState === 'family' && !stream.browser_hls?.url) { fetchFamilyStream(stream); return; }
    if (!familyStream || stream?.browser_hls?.url !== familyStream.url) familyRequest++; // A newer host offer wins.
    const offered = browserPartyStream(stream);
    // A personal source is replaced only in the opt-in automatic mode, and
    // only by a playable host source; never by a revocation or pending HLS.
    if (personalHls.active) {
      if (!autoHostStream || !offered || streamProblem(offered)) return;
      // Toggling the Desktop route can re-send the same browser offer.
      if (reason !== 'apply_current' && JSON.stringify(offered) === JSON.stringify(browserPartyStream(previousOffer))) return;
      resetVideo('Automatischer Modus: Der eigene Video-Link wurde durch die Host-Freigabe ersetzt.');
    }
    stream = offered;
    if (!stream) {
      resetVideo();
      $('streamInfo').textContent = !browserPending || browserState === 'disabled' ? 'Browser-HLS ist nicht freigegeben.'
        : browserState === 'denied' ? 'Browser-HLS nicht möglich: TorBox hat den Zugriff verweigert (Tarif oder Berechtigung). Eigenen Video-Link verwenden.'
        : browserState === 'failed' ? 'Browser-HLS konnte am Desktop nicht vorbereitet werden. Der Host kann „HLS erstellen / aktualisieren“ drücken, oder du lädst einen eigenen Video-Link.'
        : browserState === 'unsupported' ? 'Browser-HLS ist für diese Host-Quelle nicht möglich (TorBox stellt sie nicht sicher teilbar bereit). Eigenen Video-Link verwenden.'
        : browserState === 'processing' ? 'TorBox verarbeitet den Stream noch. Sobald die Playlist fertig ist, startet sie bei automatischem Laden von selbst.'
        : 'Browser-HLS wird vorbereitet; bei automatischem Laden startet die Quelle danach von selbst.';
      if (browserPending) $('noStream').textContent = browserState === 'preparing' || browserState === 'processing' ? 'Browser-HLS wird am Desktop vorbereitet …' : 'Keine abspielbare Browserquelle vom Host.';
      return;
    }
    if (stream.media_key !== mediaKey(session.room?.info.media)) return;
    const identity = JSON.stringify(stream);
    if (identity === JSON.stringify(selectedStream)) {
      if (awaitingHandoff && !soloMode) {
        handoffSourceReady = !!loadedStream;
        finishBrowserHandoff();
      }
      return;
    }
    awaitingHandoff = false;
    // Watching alone: a renewed source continues locally where it was.
    soloResume = soloMode && loadedStream ? {seconds: player.currentTime, playing: !player.paused} : null;
    // Do not keep playing a revoked or superseded source until the next user click.
    resetVideo(); selectedStream = stream;
    renderPartyRoom(); // A source is offered: leave the waiting room for the player.
    const label = String(stream.name || '').trim().slice(0, 80);
    $('streamInfo').textContent = label && !label.includes('://') ? `Host-Quelle: ${label}` : 'Host-Quelle verfügbar.';
    const problem = streamProblem(stream);
    $('loadStream').hidden = !!problem;
    if (problem) {
      // No browser_hls at all: the host's source is no integrated TorBox file
      // (e.g. an addon stream, even if its name says "TB+"), so the browser
      // only has the original. Say so instead of pretending automation works.
      $('noStream').textContent = 'Diese Quelle kann der Browser nicht abspielen. Der Host kann eine andere Quelle teilen.';
      $('streamInfo').textContent = 'Host-Quelle im Browser nicht unterstützt.';
      status(problem, true);
    }
    else if (autoHostStream && soloMode && soloResume) {
      status('Neue Host-Quelle wird geladen; du schaust weiter allein.');
      loadStream();
    }
    else if (autoHostStream) {
      // Automatic mode: load at once (new episode or renewed link) and follow
      // the current party time after metadata, like the big play button.
      startStream();
      status('Host-Stream wird automatisch geladen. Der Anbieter der Quelle erhält dabei deine IP-Adresse.');
    }
    else { $('noStream').textContent = 'Stream bereit. Tippe auf ▶, um gemeinsam zu schauen.'; status('Stream bereit. Tippe auf ▶ zum Abspielen.'); }
  },
  media: () => { hostShared = null; lastHostStreamEvent = undefined; soloMode = false; soloResume = null; resetVideo('Film gewechselt. Persönliche Quelle entfernt. Bitte eine neue eigene Quelle laden.'); $('streamInfo').textContent = 'Film gewechselt. Warte auf die neue Streamfreigabe oder lade eine eigene HLS-Quelle.'; },
  // Shared start: count down to the host's server-time start; playback itself
  // still follows the host's authoritative state (no local start here).
  countdown: payload => {
    const run = ++countdownRun;
    if (payload?.cancel === true) { status('Gemeinsamer Start abgebrochen.'); return; }
    const startAt = Number(payload?.start_at), seconds = Number(payload?.seconds);
    if (!Number.isFinite(startAt) || !(seconds >= 1 && seconds <= 10) || payload?.media_key !== mediaKey(session.room?.info.media)) return;
    const tick = () => {
      if (run !== countdownRun || !session?.room) return;
      const left = startAt - session.now();
      if (left <= 0) { status('Los geht’s!'); return; }
      status(`Gemeinsamer Start in ${Math.ceil(left / 1000)} …`);
      setTimeout(tick, Math.min(1000, Math.max(20, ((left - 1) % 1000) + 1)));
    };
    tick();
  },
  chat: (message, history = false) => {
    const line = document.createElement('div'), author = document.createElement('b');
    author.textContent = `${message.name || session.room?.members.find(m => m.id === message.member_id)?.display_name || 'Gast'}: `;
    // New messages of others also appear briefly on the player (bottom left).
    if (!history && message.member_id !== session.room?.memberId) showChatToast(author.textContent, message.body || '');
    line.append(author, document.createTextNode(message.body || ''));
    $('chatLog').append(line);
    if ($('chatLog').children.length > 100) $('chatLog').firstChild.remove();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  },
  error: e => status(friendlyError(e), true),
  closed: reason => {
    lastHostStreamEvent = undefined; familyGrant = null; familyStream = null; familyRequest++;
    // A closed party has no shared source, open proposals or waiting room.
    hostShared = null; hostMenuRoom = null; awaitingHandoff = false; proposals.length = 0; renderPartyRoom();
    $('roomShareUrl').value = ''; $('proposalUrl').value = '';
    $('roomShareStatus').textContent = ''; $('suggestStatus').textContent = '';
    $('roomProposalList').replaceChildren();
    // Party ended / host left: a loaded source may keep playing locally (see
    // "ended"). A removal, leave or new join stops it.
    if (!keepAfterPartyEnd(reason)) resetVideo('Party-Verbindung geschlossen. Persönliche Quelle entfernt.');
    $('chatLog').replaceChildren(); pendingChat = null; $('connection').textContent = 'Nicht verbunden'; renderControlInfo();
  },
  ended: (message, reason) => {
    forgetJoinedParty(); // Party end or removal: a reload must not rejoin.
    if (keepAfterPartyEnd(reason)) {
      continueLocally(`${message} Die geladene Quelle läuft lokal weiter, bis sie abläuft oder du sie schließt. Es gibt keine gemeinsame Party mehr.`);
      return;
    }
    resetVideo('Party beendet oder Mitgliedschaft verloren. Persönliche Quelle entfernt.'); showPanel('join'); status(message);
  },
}) : null;
if (session) session.browserHostLinksEnabled = browserHostShareEnabled;

// Transient toast instead of a permanent banner; errors stay a little longer.
let toastTimer = null, connectionLost = false, realtimeReconnecting = false, resumeAfterReconnect = false;
// "Host-Stream automatisch verwenden": on by default (first visit), a manual
// "off" is remembered. Only this boolean is stored locally; stream URLs and
// tokens stay in memory. The IP disclosure is stated next to the switch.
const AUTO_HOST_STREAM_KEY = 'nuvio-party-auto-host-stream';
let autoHostStream = true, lastHostStreamEvent;
// Automatic start after loading: 'loaded' → 'synced' (party position applied)
// → 'playing'; 'blocked' (browser autoplay rule) or 'muted' (started without
// sound because of that rule). awaitingPartyState: loaded before the first
// party state arrived; the start continues as soon as it does.
let autoStarting = false, autoStartPhase = null, awaitingPartyState = false;
// "Allein schauen": membership and source stay, nothing is published and
// incoming party states do not touch the local player.
let soloMode = false, soloResume = null;
try { autoHostStream = globalThis.localStorage?.getItem(AUTO_HOST_STREAM_KEY) !== '0'; } catch { /* Preference unavailable: default. */ }
// Chat overlay on the player: at most 5 toasts, newest at the bottom, each
// gone after about 5 seconds. Display only (text nodes, no markup).
const CHAT_TOAST_LIMIT = 5, CHAT_TOAST_MS = 5000;
function showChatToast(author, body) {
  const box = $('chatOverlay');
  if (!box || !String(body).trim()) return;
  const item = document.createElement('div'), name = document.createElement('b');
  item.className = 'chat-toast';
  name.textContent = author;
  item.append(name, document.createTextNode(String(body).slice(0, 240)));
  box.replaceChildren(...[...box.children, item].slice(-CHAT_TOAST_LIMIT));
  setTimeout(() => box.replaceChildren(...[...box.children].filter(child => child !== item)), CHAT_TOAST_MS);
}
function status(message, error = false) {
  $('message').textContent = message;
  $('message').style.borderColor = error ? '#ff6969' : '';
  $('message').hidden = !message;
  globalThis.clearTimeout?.(toastTimer);
  toastTimer = setTimeout(() => { $('message').hidden = true; }, error ? 9000 : 4500);
}
function showPanel(name) {
  for (const panel of ['join', 'watch']) $(panel + 'Section').hidden = panel !== name;
  // The invitation card frames both pre-join steps (sign-in and name);
  // the cinema view hides the brand bar.
  $('inviteView').hidden = name === 'watch';
  $('brandbar').hidden = name === 'watch';
  $('joinButton').textContent = session?.room ? 'Zurück zur Party' : 'Party beitreten';
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
// --- Browser host: party room, shared video link and proposals ---------------
// The host shares a direct HLS/MP4/WebM link as an ordinary host `stream`
// offer for the party title (host-share.js). Its own player then runs the
// existing sync path: its gestures become party states (broadcast, then the
// authorized watch_party_update), and with host_only=false it follows the
// members' states like any member. Memory only: after a reload of the host
// page the link has to be shared again.
let hostShared = null, hostMenuRoom = null, awaitingHandoff = false, handoffSourceReady = false, shareBusy = false;
let recoveringSource = null;

function finishSourceRecovery() {
  const recovery = recoveringSource;
  const state = session?.playback;
  if (!recovery || !state || !syncEnabled || connectionLost || waitingForTarget || player.seeking || pendingPlay ||
      player.readyState < 2 || !loadedStream || player.paused !== state.paused) return;
  if (!session.completeSourceRecovery(recovery.attempt, recovery.stream)) return;
  recoveringSource = null;
  hostShared = recovery.stream;
  $('roomShareStatus').textContent = '';
  renderPartyRoom();
  status('Video wiederhergestellt – gemeinsam verbunden');
}

function finishBrowserHandoff() {
  const state = session?.playback, room = session?.room;
  if (!awaitingHandoff || !handoffSourceReady || !loadedStream || soloMode || connectionLost ||
      !room || !state || state.member_id !== room.info.host_member_id) return;
  awaitingHandoff = handoffSourceReady = false;
  resyncNow();
  if (syncEnabled) status('Gemeinsam verbunden.');
}
const proposals = [];
let proposalSeq = 0;
// Party details live in the drawer and never hide the player.
function renderPartyRoom() {
  const room = session?.room, host = session?.isHost?.() === true;
  renderProposalForm();
  $('tabHost').hidden = !host;
  if (!room) {
    $('roomOverview').hidden = true;
    hostShared = null; hostMenuRoom = null; awaitingHandoff = false; proposals.length = 0;
    return;
  }
  if (!host) {
    if (!$('panelHost').hidden && !$('infoDrawer').hidden) selectDrawerTab('Party'); // Host role lost while open.
    hostShared = null; proposals.length = 0;
  }
  // Proposals of members who left or were removed, or for another title, expire.
  const currentKey = mediaKey(room.info.media);
  for (let i = proposals.length - 1; i >= 0; i--) {
    if (proposals[i].room !== room || proposals[i].revision !== session.hostSourceRevision ||
        proposals[i].mediaKey !== currentKey || !room.members.some(member => member.id === proposals[i].memberId)) proposals.splice(i, 1);
  }
  const hasSource = host ? !!hostShared : !!(loadedStream || selectedStream);
  $('roomOverview').hidden = false;
  $('playerWrap').hidden = false;
  $('roomKicker').textContent = host ? 'Dein Party-Room' : 'Party-Room';
  const newVideo = !host && selectedStream && !loadedStream && !streamProblem(selectedStream);
  $('roomWaiting').textContent = newVideo ? 'Neues Video verfügbar' : hasSource || host ? '' : 'Warte auf Video vom Host …';
  $('roomShareForm').hidden = !host;
  $('roomOpenHost').hidden = !host;
  $('roomPeople').replaceChildren(...room.members.map(member => {
    const item = document.createElement('li');
    item.textContent = (member.display_name || 'Mitglied') + (member.id === room.info.host_member_id ? ' · Host' : '') + (member.id === room.memberId ? ' · Du' : '');
    return item;
  }));
  const media = room.info.media || {};
  $('roomTitle').textContent = media.title || 'Party-Room';
  $('roomSubtitle').textContent = media.meta_type === 'series' && Number.isInteger(media.season) && Number.isInteger(media.episode)
    ? `Serie · Staffel ${media.season} · Episode ${media.episode}` : media.meta_type === 'movie' ? 'Film' : '';
  showImage($('roomPoster'), media.poster);
  const code = normalizeCode(room.info.code);
  $('roomInvite').value = validCode(code) ? new URL('/party/' + code, location.origin).href : '';
  if (!host) { $('roomProposals').hidden = true; return; }
  $('roomShareButton').textContent = hostShared ? 'Neues Video für alle freigeben' : 'Video für alle freigeben';
  $('roomStopShare').hidden = !hostShared;
  $('roomShowOverview').textContent = proposals.length ? `Party-Room öffnen (${proposals.length} Vorschlag${proposals.length === 1 ? '' : 'e'})` : 'Party-Room öffnen';
  // Locked sharing: the field stays visible with the reason, never a dead button.
  $('roomShareUrl').disabled = !browserHostShareEnabled;
  $('roomShareButton').disabled = !browserHostShareEnabled || shareBusy;
  $('roomShareLocked').hidden = browserHostShareEnabled;
  renderProposals();
  $('roomHostOnly').checked = room.info.host_only === true;
  $('roomMembers').replaceChildren(...room.members.map(member => {
    const item = document.createElement('li');
    item.textContent = (member.display_name || 'Mitglied') + (member.id === room.memberId ? ' · Host · Du' : '');
    if (member.id !== room.memberId) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn ghost'; button.textContent = 'Entfernen';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await session.removeMember(member.id); }
        catch (e) { status(friendlyError(e), true); }
        finally { if (session.room === room) renderPartyRoom(); }
      });
      item.append(button);
    }
    return item;
  }));
}
$('roomCopyInvite').addEventListener('click', async () => {
  if (!session?.room || !$('roomInvite').value) return; // The invite link is not secret.
  try { await navigator.clipboard.writeText($('roomInvite').value); status('Einladungslink kopiert.'); }
  catch { $('roomInvite').focus(); $('roomInvite').select?.(); status('Bitte den markierten Einladungslink kopieren.'); }
});
$('roomHostOnly').addEventListener('change', async () => {
  const input = $('roomHostOnly'), value = input.checked;
  input.disabled = true;
  try { await session.setHostOnly(value); }
  catch (e) { status(friendlyError(e), true); }
  finally { input.disabled = false; renderPartyRoom(); }
});
function renderProposals() {
  $('roomProposals').hidden = !proposals.length;
  $('roomProposalList').replaceChildren(...proposals.map(proposal => {
    const item = document.createElement('li'), label = document.createElement('span');
    label.textContent = `${proposal.name} · ${proposal.kind.toUpperCase()} · ${proposal.host}`;
    const full = document.createElement('code');
    full.className = 'room-proposal-url'; full.hidden = true;
    const address = new URL(proposal.url);
    full.textContent = classifyShareLink(proposal.url, true).family ? address.origin : address.origin + address.pathname;
    const button = (text, kind, action) => {
      const element = document.createElement('button');
      element.type = 'button'; element.className = `btn small ${kind}`; element.textContent = text;
      element.addEventListener('click', action);
      return element;
    };
    item.append(label,
      button('Link prüfen', 'ghost', () => { full.hidden = !full.hidden; }),
      button('Annehmen', 'primary', async () => {
        // Re-check against the current server snapshot: still a member, same party title.
        const room = session?.room;
        const current = () => session.room === room && room === proposal.room && session.isHost() && proposals.includes(proposal) &&
          proposal.revision === session.hostSourceRevision &&
          proposalFrom({member_id: proposal.memberId, media_key: proposal.mediaKey, url: proposal.url},
            room, mediaKey(room.info.media), browserHostShareEnabled);
        if (!current()) { dropProposal(proposal.id); status('Dieser Vorschlag gilt nicht mehr (Mitglied nicht mehr dabei oder Freigabe gewechselt).', true); return; }
        if (!await shareHostVideo(proposal.url, current)) return;
        if (session.room === room && session.isHost() && room.members.some(member => member.id === proposal.memberId))
          session.answerProposal(proposal.memberId, true);
        dropProposal(proposal.id);
      }),
      button('Ablehnen', 'ghost', () => { session.answerProposal(proposal.memberId, false); dropProposal(proposal.id); }),
      full);
    return item;
  }));
}
function dropProposal(id) {
  const index = proposals.findIndex(proposal => proposal.id === id);
  if (index >= 0) proposals.splice(index, 1);
  renderPartyRoom();
}
// Host: share a link for everyone. A new link starts paused at the beginning;
// sharing the same link again keeps the current party time.
// Order: offer (realtime), then start state (realtime + authorized RPC). They
// are two uncoupled steps, so this is best effort, not a transaction: if the
// start state cannot be published, the previous offer is announced again and
// the host's own player keeps its previous source. One action at a time.
async function shareHostVideo(input, canShare, inheritedPlayback) {
  const room = session?.room;
  if (!browserHostShareEnabled) { status('Die Videofreigabe im Browser ist gesperrt, bis das Backend den Host bestätigen kann.', true); return false; }
  if (!session?.isHost()) { status('Nur der vom Backend bestätigte Host kann Videos freigeben.', true); return false; }
  if (shareBusy) { status('Eine Freigabe läuft bereits. Bitte kurz warten.'); return false; }
  const result = hostShareStream(input, mediaKey(room.info.media), browserHostShareEnabled);
  if (result.problem) { $('roomShareStatus').textContent = result.problem; status(result.problem, true); return false; }
  const source = browserPartyStream(result.stream);
  if (source.family_beta && !inheritedPlayback &&
      !window.confirm('Dieser TorBox-Link samt Token wird an die Party gesendet. Ein Token kann Zugriff auf dein Konto geben und bleibt nach dem Austritt kopierbar. Link jetzt freigeben?')) return false;
  const same = browserPartyStream(hostShared)?.url === source.url && session.playback;
  const playback = inheritedPlayback ?? (same ? session.playback : null);
  const positionMs = playback ? expectedPositionMs(playback, session.now()) : 0;
  const reusePlayer = !!inheritedPlayback && loadedStream?.url === source.url;
  const channel = session.channel, key = mediaKey(room.info.media);
  const current = () => session.room === room && session.channel === channel && session.isHost() && mediaKey(room.info.media) === key;
  shareBusy = true; renderPartyRoom();
  $('roomShareStatus').textContent = 'Video wird freigegeben …';
  try {
    await session.shareHostStream(result.stream, {paused: inheritedPlayback?.paused ?? true, positionMs,
      previousSeq: inheritedPlayback?.seq}, canShare);
  } catch (e) {
    if (current()) {
      $('roomShareStatus').textContent = e.code === 'share_restored'
        ? 'Die vorherige Freigabe wurde wieder angekündigt; bitte erneut versuchen.'
        : e.code === 'share_restore_failed'
          ? 'Die Freigabe konnte nicht abgeschlossen und die Rücknahme nicht gesendet werden. Beim erneuten Verbinden wird nur der bisherige Freigabestand angeboten.'
          : 'Freigabe nicht gesendet. Verbindung und Party prüfen.';
      status($('roomShareStatus').textContent, true);
    }
    return false;
  } finally { shareBusy = false; if (session?.room) renderPartyRoom(); }
  if (!current() || session.hostStream !== result.stream) return false;
  if (!reusePlayer) resetVideo('Neues Video freigegeben.');
  hostShared = result.stream;
  $('roomShareUrl').value = ''; $('roomShareStatus').textContent = '';
  selectedStream = source;
  $('streamInfo').textContent = 'Du teilst einen Video-Link mit allen Mitgliedern.';
  renderPartyRoom();
  if (reusePlayer) {
    if (awaitingHandoff) { handoffSourceReady = true; finishBrowserHandoff(); }
    else if (!soloMode) resyncNow();
  }
  else startStream();
  status(inheritedPlayback ? 'Bisherige Quelle für die Party übernommen.' : 'Videoangebot gesendet. Starte mit ▶.');
  return true;
}
$('roomShareForm').addEventListener('submit', e => { e.preventDefault(); shareHostVideo($('roomShareUrl').value); });
// Closing the drawer returns to the player; a newly offered source starts
// then (automatic mode), exactly like the former "Zum Player" button.
function closeDrawerToPlayer() {
  closeDrawer();
  if (loadedStream || !selectedStream || !autoHostStream || streamProblem(selectedStream)) return;
  if (soloMode) { if (soloResume) loadStream(); }
  else startStream();
}
$('roomOpenHost').addEventListener('click', () => { openDrawer('settings', $('roomOpenHost')); selectDrawerTab('Host'); });
$('roomShowOverview').addEventListener('click', () => selectDrawerTab('Party'));
$('roomStopShare').addEventListener('click', async () => {
  if (!session?.isHost() || !hostShared || shareBusy) return;
  const room = session.room, channel = session.channel, key = mediaKey(room.info.media);
  const current = () => session.room === room && session.channel === channel && session.isHost() && mediaKey(room.info.media) === key;
  shareBusy = true; renderPartyRoom();
  try { await session.stopHostStream(); }
  catch (e) { if (current()) status('Widerruf nicht gesendet: ' + friendlyError(e), true); return; }
  finally { shareBusy = false; if (session?.room) renderPartyRoom(); }
  if (!current() || session.hostStream) return;
  hostShared = null;
  resetVideo('Videofreigabe beendet.');
  closeDrawer(); renderPartyRoom();
  status('Widerruf der Videofreigabe gesendet.');
});
// Members propose a link; only the host decides. Locked by default: the
// proposal travels over the shared party channel (every member can read it).
function renderProposalForm() {
  $('proposalSection').hidden = !session?.canSuggestBrowserLink();
  if ($('proposalSection').hidden) $('proposalUrl').value = '';
}
$('proposalForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!session?.canSuggestBrowserLink()) return;
  const room = session?.room;
  if (!room) { status('Zuerst einer Party beitreten.', true); return; }
  if (session.isHost()) { $('suggestStatus').textContent = 'Als Host gibst du Videos direkt im Party-Room frei.'; return; }
  const link = classifyShareLink($('proposalUrl').value, browserHostShareEnabled);
  if (link.problem) { $('suggestStatus').textContent = link.problem; return; }
  if (link.family && !window.confirm('Der TorBox-Link samt Token ist für Party-Mitglieder lesbar. Jetzt vorschlagen?')) return;
  $('proposalUrl').value = '';
  $('suggestStatus').textContent = 'Vorschlag wird gesendet …';
  try {
    await session.suggestStream(link.url, mediaKey(room.info.media));
    if (session.room === room) $('suggestStatus').textContent = 'Vorschlag gesendet. Der Host entscheidet über die Freigabe.';
  } catch { if (session.room === room) $('suggestStatus').textContent = 'Vorschlag nicht gesendet. Verbindung prüfen.'; }
});
$('roomEnd').addEventListener('click', async () => {
  if (!session?.isHost() || !window.confirm('Party für alle Mitglieder beenden?')) return;
  $('roomEnd').disabled = true;
  try { await session.endParty(); }
  catch (e) { status(friendlyError(e), true); }
  finally { $('roomEnd').disabled = false; }
});
function renderMembers(room) {
  const list = $('memberList');
  list.replaceChildren(...room.members.map(member => {
    const item = document.createElement('li'), avatar = document.createElement('span'), name = document.createElement('span');
    avatar.className = 'avatar'; renderAvatar(avatar, member);
    const imageUrl = safeImageUrl(member.avatar_url);
    if (imageUrl) {
      const image = document.createElement('img');
      image.alt = ''; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy';
      showImage(image, imageUrl); avatar.append(image);
    }
    name.className = 'name'; name.textContent = member.display_name || 'Gast';
    item.append(avatar, name);
    if (member.id === room.info.host_member_id) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Host'; item.append(badge); }
    if (member.id === room.memberId) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Du'; item.append(badge); }
    // Estimated distance to the party time (display only, never a command).
    const sync = memberSyncFor(room, member), note = document.createElement('span');
    note.className = `member-sync ${sync.state}`;
    note.textContent = memberSyncLabel(sync) || 'Kein Status';
    item.append(note);
    return item;
  }));
  // Compact strip under the player: up to five avatars plus the count.
  $('memberAvatars').replaceChildren(...room.members.slice(0, 5).map(member => {
    const avatar = document.createElement('span');
    avatar.className = member.id === room.info.host_member_id ? 'avatar host' : 'avatar'; renderAvatar(avatar, member);
    return avatar;
  }));
  $('memberCount').textContent = `${room.members.length}/${room.info.max_members || 3} Teilnehmer`;
  $('participantCount').textContent = room.members.length === 1 ? '1 Person' : `${room.members.length} Personen`;
  $('movieInfo').textContent = `Host: ${room.members.find(m => m.id === room.info.host_member_id)?.display_name || 'Unbekannt'}`;
  $('drawerCode').textContent = room.info.code || '–';
}
// Own row from the live player; others from their last status report.
function memberSyncFor(room, member) {
  const now = session?.now?.() ?? Date.now(), current = mediaKey(room.info.media);
  if (member.id === room.memberId) {
    if (!loadedStream) return {state: 'unknown'};
    const status = soloMode || !syncEnabled ? 'behind' : buffering || waitingForTarget || loading ? 'buffering' : 'ready';
    return memberSync({status, solo: soloMode, media_key: current, position_ms: player.currentTime * 1000, position_at: now, playing: !player.paused}, session.playback, current, now);
  }
  return memberSync(session?.memberStatus?.get(member.id), session?.playback, current, now);
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
  if (recoveringSource) {
    recoveringSource = null;
    session?.cancelSourceRecovery();
  }
  awaitingHandoff = handoffSourceReady = false;
  cancelPersonalAutoSync();
  pendingSeek = internalHlsSeek = pendingPlay = ownSeek = null;
  waitingForTarget = false;
  lastAlignedPlayback = null; lastPresence = null;
  resetSyncState(); renderQuality(null); clearSubtitles();
  mediaPointerDown = false; mediaGestureUntil = -1; lastPlaybackError = 'none';
  personalHls.clear();
  personalReadinessMessage = '';
  $('personalHlsUrl').value = '';
  $('useDesktopStream').hidden = true;
  $('personalHlsStatus').textContent = reason;
  $('suggestStatus').textContent = '';
  syncEnabled = false; loading = false; buffering = false;
  selectedStream = loadedStream = null;
  if (hls) { hls.destroy(); hls = null; }
  pauseLocally(); player.removeAttribute('src'); player.load();
  $('noStream').hidden = false; $('loadStream').hidden = true;
  $('noStream').textContent = 'Warte auf Video vom Host …';
  $('streamInfo').textContent = 'Warte auf Video vom Host oder lade einen eigenen Video-Link.';
  $('autoplayStart').hidden = true;
  $('resync').disabled = true;
  renderSoloUi();
  renderPartyRoom(); // Members without a source go back to the waiting room.
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
  if (personalAutoSync && !syncEnabled) {
    if (soloMode) personalAutoSync = null; // "Allein schauen" stays independent.
    else if (result.ready) {
      personalAutoSync = null; autoStarting = true;
      resyncNow(); return;
    } else if (!personalHls.playlist) { /* LEVEL_LOADED checks again. */ }
    else if (!result.retryable) personalAutoSync = null;
    else schedulePersonalAutoSync();
  }
  if (announce || personalReadinessMessage !== message) {
    personalReadinessMessage = message;
    $('personalHlsStatus').textContent = message;
    if (!syncEnabled) status(message);
  }
}
function schedulePersonalAutoSync() {
  const pending = personalAutoSync;
  if (!pending || pending.timer) return;
  if (pending.tries >= PERSONAL_AUTO_SYNC_TRIES) {
    personalAutoSync = null;
    status('Die eigene Quelle ist noch nicht synchronisierbar. „Party-Zeit aktualisieren“ versucht es erneut.');
    return;
  }
  pending.tries++;
  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (personalAutoSync === pending) updatePersonalHlsReadiness();
  }, PERSONAL_AUTO_SYNC_MS);
}
function cancelPersonalAutoSync() {
  if (personalAutoSync?.timer) globalThis.clearTimeout?.(personalAutoSync.timer);
  personalAutoSync = null;
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
  const solo = soloMode && !!loadedStream;
  const signature = `${state}:${behind ?? ''}:${solo}`;
  if (presenceRoom === session.room && lastPresence === signature) return;
  presenceRoom = session.room; lastPresence = signature;
  session.sendPresence(state, behind, solo).catch(() => {
    if (lastPresence === signature) lastPresence = null;
    status('Status nicht gesendet. Party-Verbindung prüfen.', true);
  });
}
// The own command is followed optimistically until the host (sequenced) or
// the server confirms it; a newer accepted state of another member always wins.
function effectivePlayback() {
  const optimistic = session?.optimisticPlayback?.();
  if (optimistic) return optimistic;
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
      $('resync').disabled = true;
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
      // Automatic start blocked by the autoplay rule: browsers allow muted
      // playback, so try once without sound and offer the sound button.
      if (error?.name === 'NotAllowedError' && autoStarting && !player.muted) {
        autoStarting = false; autoStartPhase = 'muted';
        player.muted = true; renderPlayerUi();
        status('Stumm gestartet: Der Browser erlaubt den automatischen Start nur ohne Ton. Tippe auf 🔊, um den Ton einzuschalten.');
        applySync(true); return;
      }
      if (error?.name === 'NotAllowedError') autoStartPhase = 'blocked';
      // One clear button: a tap is the gesture the browser needs to start with sound.
      $('autoplayStart').hidden = error?.name !== 'NotAllowedError';
      autoStarting = false;
      syncEnabled = false; presence();
     
      const message = error?.name === 'NotAllowedError'
        ? 'Der Browser hat den automatischen Start blockiert. Tippe auf „Wiedergabe starten“.'
        : 'Wiedergabestart fehlgeschlagen. Bitte erneut synchronisieren; bei wiederholtem Fehler eine andere kompatible Quelle laden.';
      if (personalHls.active) $('personalHlsStatus').textContent = message;
      status(message, true);
    };
    try { Promise.resolve(player.play()).then(() => {
      if (pendingPlay !== attempt) return;
      finished();
      if (loadedStream === playbackSource) {
        if (autoStarting || autoStartPhase === 'synced') { autoStarting = false; autoStartPhase = autoStartPhase === 'muted' ? 'muted' : 'playing'; }
        finishSourceRecovery();
        presence();
      }
    }, rejected); }
    catch (error) { rejected(error); }
  }
}
function failVideo(message, errorCode = 'media_error') {
  if (recoveringSource) {
    session.failSourceRecovery();
    status('Die bisherige Videoquelle ist nicht abspielbar. Bitte einen gültigen Link erneut freigeben.', true);
    return;
  }
  lastPlaybackError = errorCode;
  cancelPersonalAutoSync();
  pendingSeek = internalHlsSeek = pendingPlay = ownSeek = null;
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
  startAfterLoad = false; autoStarting = false; awaitingPartyState = false; autoStartPhase = null;
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
// The server-confirmed browser host always steers (its own player is the party clock).
const guestControl = () => (guestControlEnabled || session?.isHost?.() === true) && session?.canControl() === true;
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
    : allowed && session.canSequence() ? 'Steuerung: Play, Pause und Springen im Player gelten für alle (vom Host erlaubt). Der Desktop-Host ordnet und bestätigt jeden Befehl.'
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
  const [label, tone] = connectionLost && session?.room ? (realtimeReconnecting ? ['Verbinde neu …', 'warn'] : ['Verbindung unterbrochen', 'lost'])
    : soloMode ? ['Allein', 'off'] : !syncEnabled ? ['Nicht synchron', 'off'] : buffering || waitingForTarget ? ['Puffert …', 'warn'] : ['Synchron', ''];
  $('syncChip').hidden = !loadedStream;
  $('syncChip').textContent = label; $('syncChip').className = tone ? `sync-chip ${tone}` : 'sync-chip';
  renderSoloUi();
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
let hostOnlyNoticeAt = -Infinity;
function blocksHostOnlyControl() {
  const room = session?.room;
  if (!syncEnabled || soloMode || !room || room.memberId === room.info.host_member_id || room.info.host_only !== true) return false;
  if (performance.now() - hostOnlyNoticeAt >= 3000) {
    hostOnlyNoticeAt = performance.now();
    status('Der Host steuert die Wiedergabe. Wenn du selbst pausieren oder spulen möchtest, klicke unten rechts auf „Allein schauen“.');
  }
  return true;
}
function togglePlay() {
  if (blocksHostOnlyControl()) return;
  if (!loadedStream) {
    if (selectedStream && !$('loadStream').hidden) startStream();
    else status('Noch kein Browser-Stream freigegeben. Der Host kann „Browser-HLS freigeben“ einschalten.');
    return;
  }
  if (!player.paused) { markGesture(); player.pause(); return; }
  const party = effectivePlayback();
  // Back into a running party: start in sync instead of at the old position.
  if (!syncEnabled && !soloMode && party && !party.paused && !$('resync').disabled) { resyncNow(); return; }
  if (player.readyState < 1) { status('Die Quelle lädt noch. Gleich geht es los.'); return; }
  playLocally();
}
// Own seek controls know the target immediately: with guest control the
// command goes out at once (no waiting for a possibly slow HLS "seeked"), and
// the resulting native seeking event is recognised as ours, not re-sent.
function seekTo(seconds) {
  if (blocksHostOnlyControl()) return;
  // Only a synced, non-solo player steers the party; otherwise seek locally.
  if (guestControl() && syncEnabled && !soloMode) {
    pendingSeek = ownSeek = {seconds, at: performance.now()};
    player.currentTime = seconds;
    sendControl(effectivePlayback()?.paused ?? player.paused, seconds, 'seek');
  } else { markGesture(); player.currentTime = seconds; }
}
function skip(seconds) {
  const duration = player.duration;
  if (!loadedStream || !Number.isFinite(duration)) return;
  seekTo(Math.max(0, Math.min(duration - .1, player.currentTime + seconds)));
  renderPlayerUi(); revealControls();
}
// "Allein schauen": local playback continues, the party is neither steered
// nor followed (applySync and all senders are gated by syncEnabled/soloMode).
function enterSolo() {
  if (!session?.room || !loadedStream) return;
  cancelPersonalAutoSync();
  soloMode = true; syncEnabled = false; resumeAfterReconnect = false;
  awaitingHandoff = handoffSourceReady = false;
  pendingPlay = null; pendingSeek = ownSeek = null; userSeekPending = false;
  if (player.playbackRate !== 1) player.playbackRate = 1; // No party nudging any more.
  status('Du schaust allein weiter. Play, Pause und Springen gelten nur für dich. „Zur Party“ übernimmt wieder die Party-Zeit.');
  presence(); renderSoloUi(); renderPlayerUi();
}
// Continue the loaded source alone after a party end or host change; never
// after a removal or an explicit revocation (those reset the player).
function keepAfterPartyEnd(reason) { return (reason === 'ended' || reason === 'host_left') && !!loadedStream && !loadedStream.family_beta; }
function continueLocally(message) {
  soloMode = true; syncEnabled = false; resumeAfterReconnect = false;
  pendingPlay = null; pendingSeek = ownSeek = null; userSeekPending = false;
  if (player.playbackRate !== 1) player.playbackRate = 1;
  status(message); presence(); renderSoloUi(); renderPlayerUi();
}
function renderSoloUi() {
  $('ctlSolo').textContent = soloMode ? 'Zur Party' : 'Allein schauen';
  $('ctlSolo').setAttribute?.('aria-pressed', String(soloMode));
  $('ctlSolo').title = soloMode ? 'Wieder der Party-Zeit folgen' : 'Lokal ohne Party-Synchronisierung weiterschauen';
  $('ctlSolo').disabled = !loadedStream;
}
function toggleSolo() { if (soloMode) resyncNow(); else enterSolo(); revealControls(); }
function toggleFullscreen() {
  const wrap = $('playerWrap');
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  if (wrap.requestFullscreen) Promise.resolve(wrap.requestFullscreen()).catch(() => {});
  else player.webkitEnterFullscreen?.(); // iOS Safari: native fullscreen player.
}
const drawerTabs = ['Party', 'People', 'Advanced', 'Host'];
// "Host" exists only for the server-confirmed host (session.isHost).
const visibleDrawerTabs = () => drawerTabs.filter(name => name !== 'Host' || session?.isHost?.() === true);
let drawerOpener = null;
function selectDrawerTab(selected, focus = false) {
  if (!visibleDrawerTabs().includes(selected)) selected = 'Party';
  for (const name of drawerTabs) {
    const tab = $(`tab${name}`);
    tab.setAttribute?.('aria-selected', String(name === selected));
    tab.tabIndex = name === selected ? 0 : -1;
    $(`panel${name}`).hidden = name !== selected;
  }
  if (focus) $(`tab${selected}`).focus?.();
}
function openDrawer(view, opener) {
  if (document.fullscreenElement) document.exitFullscreen?.(); // The drawer lives outside the player.
  closeSubtitleMenu();
  if ($('infoDrawer').hidden) drawerOpener = opener;
  const participants = view === 'participants';
  // One drawer: participants are a tab, the members badge opens it directly.
  $('drawerTitle').textContent = 'Party';
  selectDrawerTab(participants ? 'People' : 'Party');
  $('infoDrawer').hidden = false; $('drawerScrim').hidden = false;
  $('partyApp').inert = true;
  $('membersButton').setAttribute?.('aria-expanded', String(participants));
  $('ctlSettings').setAttribute?.('aria-expanded', String(!participants));
  $('drawerResync').disabled = $('resync').disabled;
  $('drawerClose').focus?.();
}
function closeDrawer() {
  if ($('infoDrawer').hidden) return;
  $('infoDrawer').hidden = true; $('drawerScrim').hidden = true;
  $('partyApp').inert = false;
  $('membersButton').setAttribute?.('aria-expanded', 'false');
  $('ctlSettings').setAttribute?.('aria-expanded', 'false');
  if (!$('watchSection').hidden) drawerOpener?.focus?.();
  drawerOpener = null;
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
$('ctlSolo').addEventListener('click', toggleSolo);
$('ctlBack').addEventListener('click', backToInvite);
$('ctlSettings').addEventListener('click', () => openDrawer('settings', $('ctlSettings')));
$('membersButton').addEventListener('click', () => openDrawer('participants', $('membersButton')));
for (const name of drawerTabs) {
  const tab = $(`tab${name}`);
  tab.addEventListener('click', () => selectDrawerTab(name));
  tab.addEventListener('keydown', event => {
    const tabs = visibleDrawerTabs(), index = Math.max(0, tabs.indexOf(name));
    const target = {ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
    if (target === undefined) return;
    event.preventDefault();
    selectDrawerTab(tabs[target], true);
  });
}
$('copyPartyCode').addEventListener('click', async () => {
  const code = session?.room?.info.code;
  if (!code || !validCode(code)) return;
  try { await navigator.clipboard.writeText(code); status('Party-Code kopiert.'); }
  catch { status('Kopieren nicht möglich. Der Party-Code steht im Menü.', true); }
});
$('drawerResync').addEventListener('click', () => { if (!$('resync').disabled) resyncNow(); });
$('drawerClose').addEventListener('click', closeDrawerToPlayer);
$('drawerScrim').addEventListener('click', closeDrawerToPlayer);
$('ctlMute').addEventListener('click', () => { player.muted = !player.muted; if (!player.muted && autoStartPhase === 'muted') autoStartPhase = 'playing'; renderPlayerUi(); });
$('ctlVolume').addEventListener('input', () => { player.volume = Number($('ctlVolume').value); player.muted = player.volume === 0; renderPlayerUi(); });
$('ctlSeek').addEventListener('input', () => {
  if (blocksHostOnlyControl()) { seekDragging = false; renderPlayerUi(); return; }
  seekDragging = true;
  const duration = player.duration, value = Number($('ctlSeek').value);
  $('ctlSeek').style.setProperty?.('--fill', `${value / 10}%`);
  $('ctlRemaining').textContent = formatTime(duration - duration * value / 1000);
});
for (const event of ['pointerdown', 'keydown']) $('ctlSeek').addEventListener(event, e => {
  if (event === 'keydown' && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(e.key)) return;
  if (blocksHostOnlyControl()) { e.preventDefault(); e.stopPropagation?.(); }
});
// Consume OS/media-key actions before the browser's default player action.
const mediaSession = globalThis.navigator?.mediaSession;
if (mediaSession?.setActionHandler) {
  for (const [action, handler] of Object.entries({
    play: () => { if (!blocksHostOnlyControl() && player.paused) togglePlay(); },
    pause: () => { if (!blocksHostOnlyControl() && !player.paused) togglePlay(); },
    seekbackward: details => { if (!blocksHostOnlyControl()) skip(-(details.seekOffset || 10)); },
    seekforward: details => { if (!blocksHostOnlyControl()) skip(details.seekOffset || 10); },
    seekto: details => { if (!blocksHostOnlyControl() && Number.isFinite(details.seekTime)) seekTo(details.seekTime); },
  })) {
    try { mediaSession.setActionHandler(action, handler); } catch { /* Optional platform action. */ }
  }
}
$('ctlSeek').addEventListener('change', () => {
  if (blocksHostOnlyControl()) { seekDragging = false; renderPlayerUi(); return; }
  seekDragging = false;
  const duration = player.duration;
  if (!loadedStream || !Number.isFinite(duration)) return;
  seekTo(duration * Number($('ctlSeek').value) / 1000);
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
  else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); skip(10); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'm' || e.key === 'M') { player.muted = !player.muted; renderPlayerUi(); }
});
window.addEventListener('keydown', e => {
  if ($('infoDrawer').hidden) {
    if (e.key === 'Escape' && !$('subtitleMenu').hidden) { closeSubtitleMenu(); $('ctlSubtitles').focus?.(); }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
  if (e.key !== 'Tab') return;
  const items = [...($('infoDrawer').querySelectorAll?.('button, input, select, summary, [tabindex]') || [])]
    .filter(item => !item.disabled && item.tabIndex >= 0 && !item.closest('[hidden]'));
  const first = items[0], last = items.at(-1);
  if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
  }
});
// Mouse: single click = play/pause, double click = fullscreen. The single
// click waits briefly, so a double click never sends two play/pause commands.
// Touch keeps tap = show/hide controls (fullscreen via its button).
const DOUBLE_CLICK_MS = 250;
let singleClickTimer = null;
player.addEventListener('click', e => {
  if (lastPointerType !== 'mouse') { if (controlsShownAtPointer) hideControls(); else revealControls(); return; }
  if ((e?.detail ?? 1) > 1) return; // Second click of a double click.
  globalThis.clearTimeout?.(singleClickTimer);
  singleClickTimer = setTimeout(() => { singleClickTimer = null; togglePlay(); }, DOUBLE_CLICK_MS);
});
player.addEventListener('dblclick', e => {
  if (lastPointerType !== 'mouse') return;
  e?.preventDefault?.();
  globalThis.clearTimeout?.(singleClickTimer); singleClickTimer = null;
  toggleFullscreen();
});
for (const event of ['timeupdate', 'play', 'pause', 'durationchange', 'volumechange', 'emptied']) player.addEventListener(event, () => renderPlayerUi());
// Host-sequenced (Nuvio Desktop fork ≥ 0.1.39): every gesture is one command
// with its own ID, sent at once: no RPC from the browser, no queue, no lock.
// The host orders it; an identical seek that is still open is not repeated.
function sendSequenced(paused, seconds, kind) {
  const open = session.latestCommand;
  if (kind === 'seek' && open && open.kind === 'seek' && !open.reached && ['pending', 'accepted'].includes(open.status) &&
      open.command.paused === paused && Math.abs(open.command.position_ms - seconds * 1000) < 250) return true;
  try { session.issueCommand({paused, positionMs: seconds * 1000, kind}); }
  catch { return false; }
  applySync(); renderControlInfo();
  return true;
}
const REJECTED_TEXT = {
  host_only: 'Der Host hat die Gaststeuerung deaktiviert. Party-Zeit wird wieder übernommen.',
  superseded: 'Ein neuerer Befehl war schneller. Party-Zeit wird übernommen.',
  stale_epoch: 'Host oder Film hat gewechselt. Der Befehl gilt nicht mehr.',
};
function commandSettled(entry) {
  // Only the latest gesture speaks; older ones were already overtaken.
  if (entry === session.latestCommand) {
    if (entry.status === 'accepted' && !entry.stale) status(entry.kind === 'seek' ? 'Gesprungen für alle.' : entry.command.paused ? 'Pause für alle.' : 'Wiedergabe für alle.');
    else if (entry.status === 'rejected') status(REJECTED_TEXT[entry.reason] || 'Der Host hat den Befehl abgelehnt. Party-Zeit wird übernommen.', true);
    else if (entry.status === 'unknown') status('Keine Antwort vom Host. Der aktuelle Party-Zustand wird vom Server geladen.', true);
  }
  applySync(); renderControlInfo(); renderSyncDebug();
}
// Local user gesture → shared command. Coalesced: one RPC in flight, the
// latest gesture queued. Confirmed states arrive via acceptPlayback.
function sendControl(paused, seconds, kind = 'toggle') {
  if (!guestControl() || soloMode) return false;
  if (session.canSequence()) return sendSequenced(paused, seconds, kind);
  const request = {paused, seconds};
  if (pendingCommand) { queuedCommand = request; return true; }
  let command;
  try { command = session.prepareControl({paused, positionMs: seconds * 1000}); }
  catch { return false; }
  pendingCommand = command;
  applySync();
  // Host: broadcast first, then persisted by the authorized RPC (like Desktop).
  session.commitControl(command, {mode: session.isHost() ? 'desktop' : guestControlMode}).then(() => {
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
  renderPartyRoom();
  $('resync').disabled = true; $('loadStream').hidden = true;
  status('Quelle wird geladen. Erst nach erfolgreichem Laden ist die Synchronisierung verfügbar.');
  try {
    if (streamIsHls(stream)) {
      if (!stream.family_beta && player.canPlayType('application/vnd.apple.mpegurl') && !Object.keys(stream.headers || {}).length) { player.src = stream.url; renderQuality(null, true); }
      else if (Hls.isSupported()) {
        // TorBox link with token: variants/segments that lost the query get the same token.
        let ownToken = null;
        try { ownToken = stream.propagate_token === true ? new URL(stream.url).searchParams.get('token') : null; } catch { ownToken = null; }
        const familyToken = (familyStream && familyStream.url === stream.url ? familyStream.token : null) || ownToken;
        const instance = new Hls({...HLS_TUNING, debug: false, enableWorker: true, ...(stream.family_beta ? {
          progressive: true,
          fetchSetup: async (context, init) => familyHlsRequest(stream.url, context.url, init),
        } : {xhrSetup: (xhr, requestUrl) => {
          // Family share with propagate_token: variants that lost the query get the same token.
          const target = familyToken ? withFamilyToken(requestUrl, familyToken) : requestUrl;
          if (target !== requestUrl) xhr.open('GET', target, true);
          xhr.withCredentials = false;
          for (const [name, value] of Object.entries(stream.headers || {})) xhr.setRequestHeader(name, value);
        }})});
        if (stream.family_beta && instance.config.loader === Hls.DefaultConfig.loader) {
          instance.destroy();
          return failVideo('Dieser Browser kann TorBox-HLS mit geschützter Weiterleitungsprüfung nicht laden.');
        }
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

// Admitted guests get the host's address from the share service with their own
// session and membership; a per-guest grant refreshes it after a reconnect.
const FAMILY_RETRY_LIMIT = 3;
async function fetchFamilyStream(offer, attempt = 0) {
  const room = session?.room, request = ++familyRequest;
  if (!SHARE_WORKER) {
    $('streamInfo').textContent = 'Der Host teilt per Familienfreigabe. Sie ist in diesem Browser-Build nicht eingerichtet; eigenen Video-Link verwenden.';
    return;
  }
  if (!room) return;
  const post = async (action, body, jwt) => {
    const headers = {'Content-Type': 'application/json'};
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    const response = await fetch(`${SHARE_WORKER}/v1/${action}`, {method: 'POST', headers, body: JSON.stringify({party_id: room.info.id, ...body}), credentials: 'omit', cache: 'no-store'});
    return {status: response.status, retryAfter: Number(response.headers?.get?.('Retry-After')), body: await response.json().catch(() => ({}))};
  };
  let result = null;
  try {
    if (familyGrant && familyGrant.party === room.info.id && familyGrant.expires > Date.now()) {
      result = await post('stream', {grant: familyGrant.grant});
      // A throttled reconnect keeps the grant; only a refused one is dropped.
      if (result.status !== 200 && result.status !== 429) { familyGrant = null; result = null; }
    }
    if (!result) {
      const {data: {session: auth} = {}} = await client.auth.getSession();
      if (!auth?.access_token) throw new Error('auth');
      result = await post('grant', {device_id: deviceId}, auth.access_token);
      if (result.status === 200) familyGrant = {party: room.info.id, grant: result.body.grant, expires: Number(result.body.expires_at) || 0};
    }
  } catch { result = {status: 0, body: {}}; }
  if (request !== familyRequest || session?.room !== room) return; // Superseded.
  if (result.status === 429) {
    // Throttled by the Worker: the current source keeps playing; retry a few times.
    const seconds = Number.isFinite(result.retryAfter) && result.retryAfter > 0 ? Math.min(result.retryAfter, 300) : 60;
    if (attempt < FAMILY_RETRY_LIMIT) {
      setTimeout(() => { if (request === familyRequest && session?.room === room) fetchFamilyStream(offer, attempt + 1); }, seconds * 1000);
      $('streamInfo').textContent = `Familienfreigabe: gerade zu viele Anfragen. Neuer Versuch in ${seconds} s.`;
    } else $('streamInfo').textContent = 'Familienfreigabe: weiterhin zu viele Anfragen. Beim nächsten Host-Update wird es erneut versucht.';
    return;
  }
  const url = result.status === 200 ? String(result.body.url || '') : '';
  if (!url || result.body.media_key !== offer.media_key) {
    // Not (or no longer) admitted: a running family source stops at once.
    if (familyStream && loadedStream?.url === familyStream.url) resetVideo();
    familyStream = null;
    $('streamInfo').textContent = result.status === 403
      ? 'Familienfreigabe: Du bist (noch) nicht zugelassen. Der Host kann dich im Party-Menü unter „Familienfreigabe“ einschalten.'
      : result.status === 404 ? 'Familienfreigabe ist noch nicht aktiv. Sie startet, sobald der Host dich zulässt.'
      : 'Familienfreigabe gerade nicht erreichbar. Beim nächsten Host-Update wird es erneut versucht.';
    $('noStream').textContent = 'Keine Browserquelle für dich freigegeben.';
    return;
  }
  // The token is the query of the shared address itself; kept in memory only.
  let token = null;
  try { token = result.body.propagate_token === true ? new URL(url).searchParams.get('token') : null; } catch { token = null; }
  familyStream = {url, token};
  session.handlers.stream({media_key: offer.media_key, url: '', stream_type: 'hls', browser_hls: {url, label: 'TorBox (Familie)'}});
}

$('personalHlsForm').addEventListener('submit', e => {
  e.preventDefault();
  const value = $('personalHlsUrl').value.trim();
  // Local loading never broadcasts the URL; only the explicit suggestion action does.
  $('personalHlsUrl').value = '';
  if (!session?.room) { status('Zuerst als angemeldetes Mitglied einer Party beitreten.', true); return; }
  const media = session.room.info.media;
  const currentMediaKey = media?.meta_type && media?.meta_id ? mediaKey(media) : '';
  const problem = personalHlsUrlProblem(value) || (!currentMediaKey ? 'Die Party hat noch keine gültige Filmkennung. Bitte den Host prüfen und erneut laden.' : '');
  if (problem) { $('personalHlsStatus').textContent = problem; status(problem, true); return; }
  const solo = soloMode;
  resetVideo();
  cancelPersonalAutoSync();
  if (!solo) personalAutoSync = {tries: 0, timer: null};
  loadedStream = {personal: true, media_key: currentMediaKey};
  renderPartyRoom();
  loading = true;
  $('useDesktopStream').hidden = false;
  $('streamInfo').textContent = 'Persönliche HLS-Quelle';
  $('personalHlsStatus').textContent = 'Playlist wird geprüft …';
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
  $('streamInfo').textContent = 'Persönliche Quelle gelöscht. Warte auf die aktuelle Freigabe des Hosts.';
  session?.requestState().catch(() => status('Die Freigabe des Hosts konnte nicht angefragt werden. Verbindung prüfen.', true));
});
$('autoHostStream').checked = autoHostStream;
$('autoHostStream').addEventListener('change', () => {
  autoHostStream = $('autoHostStream').checked === true;
  try { globalThis.localStorage?.setItem(AUTO_HOST_STREAM_KEY, autoHostStream ? '1' : '0'); } catch { /* Session only. */ }
  // Enabling it (a user gesture) applies the host source that is already offered.
  if (!autoHostStream || !session?.room) return;
  if (selectedStream && !loadedStream && !$('loadStream').hidden) startStream();
  else if (lastHostStreamEvent) session.handlers.stream(lastHostStreamEvent, 'apply_current');
  else session.requestState().catch(() => {});
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
// With an invitation link "Party beitreten" is the primary action, otherwise
// "Party erstellen" (CSS orders and weights the two; no logic changes).
setClass($('joinSection'), 'invite-first', validCode($('partyCode').value));
function updateInviteLinks() {
  const code = normalizeCode($('partyCode').value), valid = validCode(code);
  $('openInNuvio').hidden = !valid;
  if (valid) $('openInNuvio').href = `https://nuvio.tv/party/${code}`;
}
async function preview() {
  updateInviteLinks();
  if (!client) return;
  if (!validCode($('partyCode').value)) {
    // Home page or an empty field: just the join form. Only a broken
    // /party/… link or a typed invalid code gets a notice.
    const brokenLink = /^\/party\//i.test(location.pathname) && !partyCodeFromPath(location.pathname);
    $('preview').textContent = brokenLink ? 'Dieser Einladungslink enthält keinen gültigen Party-Code. Bitte den Link erneut öffnen oder den Party-Code eingeben.'
      : $('partyCode').value.trim() ? 'Der Party-Code hat sechs Zeichen (Buchstaben und Ziffern aus der Einladung).' : '';
    return;
  }
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
// Sign-in and join are one flow: the existing Nuvio account (Supabase
// signInWithPassword) is used only when no valid session exists; anonymous
// sign-in is never used. The display name comes from the account.
const cleanName = value => {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 36);
  return name && !name.includes('@') ? name : ''; // Never publish an e-mail address.
};
// 1. Nuvio profile name (sync_pull_profiles, the same authorized RPC as
// Desktop), 2. account metadata name, 3. neutral fallback.
async function accountDisplayName(user, profileIndex) {
  try {
    const profiles = await callRpc(client, 'sync_pull_profiles');
    if (Array.isArray(profiles) && profiles.length) {
      const sorted = [...profiles].sort((a, b) => (a?.profile_index ?? 0) - (b?.profile_index ?? 0));
      const profile = (profileIndex != null && sorted.find(item => item?.profile_index === profileIndex)) || sorted[0];
      const name = cleanName(profile?.name);
      if (name) return name;
    }
  } catch { /* Fall back to account metadata. */ }
  const metadata = user?.user_metadata || {};
  for (const key of ['display_name', 'full_name', 'name', 'username', 'preferred_username']) {
    const name = cleanName(metadata[key]);
    if (name) return name;
  }
  // 3. The part before "@" of the account e-mail (never the full address).
  const local = cleanName(String(user?.email || '').split('@')[0].replace(/[^\p{L}\p{N}._ -]/gu, ''));
  if (local.length >= 2) return local;
  return 'Nuvio-Mitglied';
}
const usableSession = auth => !!auth?.user && !auth.user.is_anonymous;
// Credentials only without a valid session.
function renderAuthState(signedIn) {
  $('credentials').hidden = signedIn;
  $('accountLine').hidden = !signedIn;
}
let joining = false;
let roomSearchTimer, roomSearchRevision = 0, roomTitleDetails = null, chosenRoomMedia = null;

function setChosenRoomMedia(media) {
  chosenRoomMedia = media;
  $('createRoomButton').disabled = joining || !media;
}

function roomOptions(id, placeholder, items) {
  const select = $(id);
  const options = [['', placeholder], ...items].map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value; option.textContent = label;
    return option;
  });
  select.replaceChildren(...options);
  select.value = '';
}

async function chooseRoomTitle(result) {
  const revision = ++roomSearchRevision;
  $('roomSearchResults').replaceChildren();
  $('roomEpisodePicker').hidden = true;
  roomTitleDetails = null;
  setChosenRoomMedia(null);
  $('roomSearchStatus').textContent = 'Titel wird bestätigt …';
  try {
    const details = await loadRoomTitle(result.type, result.id);
    if (revision !== roomSearchRevision) return;
    if (result.type === 'series' && !details.episodes.length) {
      $('roomSearchStatus').textContent = 'Für diese Serie sind keine gültigen Episoden verfügbar.';
      return;
    }
    roomTitleDetails = details;
    $('roomSearchStatus').textContent = details.media.title;
    if (result.type === 'movie') {
      setChosenRoomMedia(details.media);
      return;
    }
    const seasons = [...new Set(details.episodes.map(video => video.season))];
    roomOptions('roomSearchSeason', 'Staffel auswählen', seasons.map(number => [String(number), 'Staffel ' + number]));
    roomOptions('roomSearchEpisode', 'Zuerst Staffel auswählen', []);
    $('roomSearchEpisode').disabled = true;
    $('roomEpisodePicker').hidden = false;
  } catch {
    if (revision === roomSearchRevision) $('roomSearchStatus').textContent = 'Der Titel konnte bei Cinemeta nicht bestätigt werden. Suche erneut oder verwende die manuelle Eingabe.';
  }
}

$('roomSearchSeason').addEventListener('change', () => {
  setChosenRoomMedia(null);
  const season = $('roomSearchSeason').value;
  const episodes = season === '' ? [] : roomTitleDetails?.episodes.filter(video => video.season === Number(season)) ?? [];
  roomOptions('roomSearchEpisode', episodes.length ? 'Episode auswählen' : 'Zuerst Staffel auswählen',
    episodes.map(video => [String(video.episode), 'Episode ' + video.episode + (typeof video.title === 'string' ? ' · ' + video.title : '')]));
  $('roomSearchEpisode').disabled = !episodes.length;
});

$('roomSearchEpisode').addEventListener('change', () => {
  setChosenRoomMedia(null);
  const season = $('roomSearchSeason').value, episode = $('roomSearchEpisode').value;
  if (!roomTitleDetails || season === '' || episode === '') return;
  setChosenRoomMedia(roomMediaForEpisode(roomTitleDetails, Number(season), Number(episode)));
});

$('roomSearch').addEventListener('input', () => {
  const revision = ++roomSearchRevision;
  const query = $('roomSearch').value.trim();
  clearTimeout(roomSearchTimer);
  roomTitleDetails = null;
  setChosenRoomMedia(null);
  $('roomSearchResults').replaceChildren();
  $('roomEpisodePicker').hidden = true;
  $('roomSearchStatus').textContent = query.length >= 2 ? 'Cinemeta wird durchsucht …'
    : query ? 'Gib mindestens zwei Zeichen ein.' : '';
  if (query.length < 2) return;
  roomSearchTimer = setTimeout(async () => {
    try {
      const results = await searchRoomMedia(query);
      if (revision !== roomSearchRevision) return;
      for (const result of results) {
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.className = 'btn room-result';
        if (result.poster) {
          const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy';
          showImage(image, result.poster); button.append(image);
        }
        const label = document.createElement('span');
        label.textContent = [result.title, result.year, result.type === 'movie' ? 'Film' : 'Serie'].filter(Boolean).join(' · ');
        button.append(label);
        button.addEventListener('click', () => {
          if (revision === roomSearchRevision) chooseRoomTitle(result);
        });
        item.append(button); $('roomSearchResults').append(item);
      }
      $('roomSearchStatus').textContent = results.length ? 'Wähle einen Titel aus.' : 'Keine passenden Filme oder Serien gefunden.';
    } catch {
      if (revision === roomSearchRevision) $('roomSearchStatus').textContent = 'Cinemeta konnte nicht geladen werden. Prüfe deine Verbindung und versuche es erneut.';
    }
  }, 300);
});

async function joinParty({auto = false, create = false} = {}) {
  if (!session) return status(configProblem, true);
  // Already a member (came back via the back arrow): return without re-joining.
  if (session.room) {
    showPanel('watch');
    if (loadedStream && !$('resync').disabled) resyncNow();
    return;
  }
  if (joining) return; // No double sign-in or join.
  const code = normalizeCode($('partyCode').value);
  if (!create && !validCode(code)) return status('Bitte den sechsstelligen Party-Code aus der Einladung eingeben.', true);
  const selectedMedia = chosenRoomMedia;
  const manual = create === 'manual';
  const manualId = manual ? $('roomMediaId').value.trim() : '';
  if (create && !(manual ? manualId : selectedMedia))
    return status('Wähle einen gültigen Titel oder gib einen IMDb-Link ein.', true);
  const manualType = manual ? $('roomMediaType').value : '';
  const manualSeason = manual && $('roomSeason').value !== '' ? Number($('roomSeason').value) : null;
  const manualEpisode = manual && $('roomEpisode').value !== '' ? Number($('roomEpisode').value) : null;
  const rawIndex = $('profileIndex').value.trim();
  const profileIndex = rawIndex === '' ? null : Number(rawIndex);
  if (profileIndex != null && (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 20)) return status('Ungültiger Profilindex.', true);
  joining = true;
  $('joinButton').disabled = true;
  $('createRoomButton').disabled = true;
  $('createRoomManual').disabled = true;
  try {
    let {data: {session: auth} = {}} = await client.auth.getSession();
    if (!usableSession(auth)) {
      renderAuthState(false);
      const email = $('email').value.trim(), password = $('password').value;
      if (!email || !password) { status('Bitte mit deinem Nuvio-Konto anmelden: E-Mail und Passwort eingeben.', true); $(email ? 'password' : 'email').focus?.(); return; }
      $('joinButton').textContent = 'Anmeldung …';
      const {data, error} = await client.auth.signInWithPassword({email, password});
      $('password').value = ''; // Never kept or logged.
      if (error || !usableSession(data?.session ? data.session : {user: data?.user})) {
        status('Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort deines Nuvio-Kontos prüfen.', true);
        return;
      }
      auth = data.session || {user: data.user};
      renderAuthState(true);
    }
    $('joinButton').textContent = create ? 'Titel wird bestätigt und Party erstellt …' : 'Party wird betreten …';
    const name = await accountDisplayName(auth.user, profileIndex);
    if (create) {
      const media = manual ? await resolveRoomMedia(manualType, manualId, manualSeason, manualEpisode) : selectedMedia;
      await session.create(media, name, profileIndex);
    } else await session.join(code, name, profileIndex);
    if (session.room) {
      const confirmedCode = normalizeCode(session.room.info.code);
      if (!validCode(confirmedCode)) throw new Error('Backend-Antwort enthält keinen gültigen Party-Code.');
      rememberJoinedParty(confirmedCode);
      $('partyCode').value = confirmedCode;
      // Joined via "/" or a typed code: make the URL /party/<CODE>, so a reload
      // finds the same party (the code is not secret; no source is added).
      if (partyCodeFromPath(location.pathname) !== confirmedCode) {
        try { globalThis.history?.replaceState?.(null, '', `/party/${confirmedCode}`); } catch { /* URL unchanged. */ }
      }
    }
    status(session.isHost() ? 'Party geöffnet. Host-Verwaltung vom Backend bestätigt.'
      : auto ? 'Party nach dem Neuladen wieder betreten. Host-Freigabe und Party-Zeit werden angefragt …' : 'Party beigetreten.');
    if (auto && session.isHost() && !loadedStream && !selectedStream) session.armSourceRecovery();
  } catch (err) {
    showPanel('join');
    // Expired or revoked session: show the sign-in fields again.
    if (err?.code === 'PGRST301' || err?.status === 401 || /jwt|expired|not authenticated/i.test(String(err?.message || ''))) {
      renderAuthState(false); status('Deine Sitzung ist abgelaufen. Bitte erneut mit deinem Nuvio-Konto anmelden.', true);
    } else status((create ? 'Erstellung fehlgeschlagen: ' : 'Beitritt fehlgeschlagen: ') + friendlyError(err), true);
    // A definitive answer ends the automatic rejoin for this tab.
    if (['party_not_found', 'party_full', 'removed', 'not_member', 'party_ended', 'unavailable'].includes(err?.code)) forgetJoinedParty();
  }
  finally { joining = false; $('joinButton').disabled = false; setChosenRoomMedia(chosenRoomMedia); $('createRoomManual').disabled = false; $('joinButton').textContent = session.room ? 'Zurück zur Party' : 'Party beitreten'; }
}
$('createRoomButton').addEventListener('click', () => joinParty({create: true}));
$('createRoomManual').addEventListener('click', () => joinParty({create: 'manual'}));
$('joinForm').addEventListener('submit', e => { e.preventDefault(); joinParty(); });
// Sign out: visible only with a session (inside the account line).
// Preview password gate (functions/_middleware.js): the logout POST must carry
// the real Origin, which "no-referrer" pages would send as "null"; this one
// request therefore uses referrerPolicy "same-origin". Not on production.
$('previewLogoutRow').hidden = !globalThis.location?.hostname?.endsWith('.nuvio-watch-friends.pages.dev');
$('previewLogout').addEventListener('click', async () => {
  try { await fetch('/__preview/logout', {method: 'POST', credentials: 'same-origin', referrerPolicy: 'same-origin', redirect: 'manual'}); } catch { /* Login page follows anyway. */ }
  globalThis.location?.assign?.('/__preview/login');
});
$('showDiagnostics').addEventListener('click', () => {
  debugEnabled = true;
  renderSyncDebug();
  const details = $('diagnosticsPanel').firstElementChild;
  if (details) { details.open = true; details.firstElementChild?.focus(); }
});
$('logoutButton').addEventListener('click', async () => { forgetJoinedParty(); await session?.close(); await client?.auth.signOut(); renderAuthState(false); showPanel('join'); status('Abgemeldet.'); });
$('invitePlay').addEventListener('click', () => joinParty());
$('passwordToggle').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('passwordToggle').textContent = show ? 'Verbergen' : 'Anzeigen';
  $('passwordToggle').setAttribute?.('aria-pressed', String(show));
  $('passwordToggle').setAttribute?.('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
});
$('loadStream').addEventListener('click', startStream);
function resyncNow() {
  // After a party end there is no party time to return to.
  if (!session?.room && soloMode) { status('Die Party ist beendet. Für eine neue Party den Einladungslink öffnen.'); return; }
  if (awaitingHandoff) {
    status('Synchronisierung wird übernommen …');
    session?.requestState().catch(() => {});
    return;
  }
  // Back to the party time always ends "Allein schauen".
  if (soloMode) { soloMode = false; renderSoloUi(); }
  // A lost subscription is not repaired by requestState/applySync: rebuild it
  // first; the party time is applied once it is SUBSCRIBED again.
  if (connectionLost && session?.room) {
    resumeAfterReconnect = true;
    status('Party-Verbindung wird neu aufgebaut …');
    session.reconnect().catch?.(() => {});
    return;
  }
  if (!session?.playback) {
    // Automatic start: continue as soon as the first party state arrives.
    if (autoStarting) { awaitingPartyState = true; status('Quelle geladen. Warte auf die Party-Zeit des Hosts …'); session?.requestState().catch(() => {}); return; }
    status('Noch keine Party-Zeit vom Host. Sie wird angefragt …');
    session?.requestState().catch(() => status('Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
    return;
  }
  pendingPlay = null; // An explicit retry owns a new start attempt.
  syncEnabled = true;
  session.requestState().catch(() => status('Aktueller Host-Zustand konnte nicht angefragt werden. Realtime-Verbindung prüfen.', true));
 
  applySync(true); presence(); renderPlayerUi();
  if (syncEnabled && loadedStream && autoStartPhase !== 'muted') autoStartPhase = !player.paused ? 'playing' : 'synced';
  if (syncEnabled && !waitingForTarget && session.playback.paused) { autoStarting = false; status('Der Host hat pausiert. Die Wiedergabe startet, sobald er fortsetzt.'); }
  finishSourceRecovery();
}
$('resync').addEventListener('click', resyncNow);
player.addEventListener('loadedmetadata', () => {
  if (!loadedStream) return;
  if (personalHls.active) { updatePersonalHlsReadiness(true); return; }
  loading = false; $('noStream').hidden = true; $('resync').disabled = false;
  autoStartPhase = 'loaded';
  // "Allein schauen" during a source renewal: continue locally where it was.
  if (soloMode && soloResume) {
    const resume = soloResume; soloResume = null; startAfterLoad = false;
    try { player.currentTime = resume.seconds; } catch { /* Not seekable yet. */ }
    if (resume.playing) playLocally();
    status('Neue Quelle geladen. Du schaust weiter allein.'); presence(); return;
  }
  status(startAfterLoad ? 'Quelle geladen. Party-Zeit wird übernommen …'
    : 'Metadaten geladen. Klicke auf „Party-Zeit aktualisieren“. Codecfehler können erst beim Start sichtbar werden.');
  presence();
  // Started via the big play button or automatically: follow the party at
  // once. A blocked autoplay falls back to muted playback (see applySync).
  if (startAfterLoad) { startAfterLoad = false; autoStarting = true; resyncNow(); }
});
// Native controls do not identify the origin of a seeking event. Track actual
// control gestures rather than assuming every hls.js currentTime write is a user seek.
player.addEventListener('pointerdown', () => { mediaPointerDown = true; mediaGestureUntil = performance.now() + 1500; });
for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, () => {
  if (mediaPointerDown) { mediaPointerDown = false; mediaGestureUntil = performance.now() + 1500; }
});
window.addEventListener('blur', () => { mediaPointerDown = false; mediaGestureUntil = -1; });
player.addEventListener('keydown', e => {
  if ([' ', 'Spacebar', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) &&
      blocksHostOnlyControl()) { e.preventDefault(); e.stopPropagation?.(); return; }
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
    // ownSeek: a seek from our own controls whose command was already sent.
    if (matches(pendingSeek) || internal || matches(ownSeek)) { presence(); return; }
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
  syncEnabled = false;
  pendingPlay = null;
  pendingSeek = internalHlsSeek = null;
  mediaPointerDown = false; mediaGestureUntil = -1;
  status('Lokal pausiert oder gespult. Zum Anschluss an die Party erneut synchronisieren.'); presence(); renderPlayerUi();
});
player.addEventListener('seeked', () => {
  pendingSeek = internalHlsSeek = ownSeek = null;
  // seeked = target position decodable; also the end of a seek's load delay.
  if (!buffering) mediaResumed();
  if (userSeekPending) {
    userSeekPending = false;
    const p = effectivePlayback();
    if (syncEnabled && sendControl(p?.paused ?? player.paused, player.currentTime, 'seek')) { presence(); return; }
  }
  applySync(); finishSourceRecovery(); presence();
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
player.addEventListener('playing', () => { $('autoplayStart').hidden = true; buffering = false; mediaResumed(); applySync(); finishSourceRecovery(); presence(); });
// Autoplay fallback: the tap itself starts playback at the current party time.
$('autoplayStart').addEventListener('click', () => { $('autoplayStart').hidden = true; markGesture(); resyncNow(); });
player.addEventListener('canplay', () => { buffering = false; mediaResumed(); applySync(); finishSourceRecovery(); presence(); });
player.addEventListener('error', () => { if (loadedStream && player.error) failVideo('Video nicht abspielbar: möglicher Codec-/Containerfehler, CORS, DRM, abgelaufener Link oder fehlende Zugriffsrechte. Der Browser nennt die Ursache häufig nicht genauer.'); });
function renderSyncDebug() {
  if (!debugEnabled) return;
  if (!debugOutput) {
    const details = document.createElement('details'), title = document.createElement('summary');
    title.textContent = 'Lokale Sync-Diagnose';
    debugOutput = document.createElement('pre'); details.append(title, debugOutput);
    $('diagnosticsPanel').append(details);
    $('showDiagnostics').hidden = true;
  }
  const d = session?.diagnostics || {}, p = session?.playback;
  const number = value => Number.isFinite(value) ? value : null;
  const choice = (value, allowed) => allowed.includes(value) ? value : null;
  const hostPosition = p ? expectedPositionMs(p, session.now()) / 1000 : null;
  debugOutput.textContent = JSON.stringify({
    realtime: choice(d.connection, ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'CONNECTING']),
    // Status changes with timestamps and fixed reason categories only.
    realtimeReconnects: number(d.reconnects),
    realtimeLog: (d.connectionLog || []).slice(-10).map(e => ({at: e.at, state: choice(e.state, ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'CONNECTING']),
      reason: choice(e.reason, ['auth_token', 'not_authorized', 'rate_limited', 'timeout', 'network', 'other'])})),
    // Distinguishes "connected but no playback received" from a lost channel.
    msSinceRealtimeState: d.lastRealtimeAt ? number(Date.now() - d.lastRealtimeAt) : null,
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
    lastCommandResult: choice(d.lastCommandResult, ['confirmed', 'stored_not_broadcast', 'broadcast', 'persisted', 'persist_failed', 'broadcast_failed', 'host_only', 'not_confirmed', 'closed', 'rpc_failed', 'pending', 'accepted', 'applied', 'rejected', 'unknown']),
    // Host-sequenced commands: fixed labels only, never IDs.
    hostSequencer: session?.hostCommands === true,
    autoStart: choice(autoStartPhase, ['loaded', 'synced', 'playing', 'blocked', 'muted']), awaitingPartyState, soloMode,
    latestCommandStatus: choice(session?.latestCommand?.status, ['pending', 'accepted', 'applied', 'rejected', 'unknown']),
    latestCommandReason: choice(session?.latestCommand?.reason, ['host_only', 'superseded', 'stale_epoch', 'not_member', 'invalid', 'rejected']),
  }, null, 2);
}
// Sparse position report (about every 10 s) for the members' sync display.
const POSITION_REPORT_MS = 10000;
let lastPositionReportAt = -Infinity;
if (session) session.positionProvider = () => loadedStream && Number.isFinite(player.currentTime)
  ? {position_ms: player.currentTime * 1000, playing: !player.paused} : null;
setInterval(() => {
  applySync(); presence(); renderControlInfo(); renderSyncDebug();
  if (session?.room && loadedStream && performance.now() - lastPositionReportAt >= POSITION_REPORT_MS) {
    lastPositionReportAt = performance.now();
    session.reportPosition?.().catch?.(() => {});
  }
  if (session?.room && !$('infoDrawer').hidden) renderMembers(session.room);
  $('drawerResync').disabled = $('resync').disabled;
}, 1000);
$('leaveButton').addEventListener('click', async () => { forgetJoinedParty(); await session?.close(); showPanel('join'); status('Party verlassen.'); });
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
  if (event === 'SIGNED_OUT') setTimeout(async () => { forgetJoinedParty(); await session.close(false); renderAuthState(false); showPanel('join'); status('Sitzung beendet. Bitte erneut mit deinem Nuvio-Konto anmelden.'); }, 0);
});
(async () => {
  if (!client) { showPanel('join'); $('joinButton').disabled = true; status(configProblem, true); return; }
  try {
    const {data: {session: auth} = {}, error} = await client.auth.getSession();
    if (error) throw error;
    // Valid session: no credentials. Otherwise e-mail and password inline.
    renderAuthState(usableSession(auth));
    if (!session?.room) { showPanel('join'); await preview(); }
    // Reload of an active membership in this tab: join the same party again.
    const code = partyCodeFromPath(location.pathname);
    if (code && usableSession(auth) && joinedPartyCode() === code && !session?.room) {
      status('Party wird nach dem Neuladen wieder betreten …');
      await joinParty({auto: true});
    }
  } catch (e) { if (!session?.room) { renderAuthState(false); showPanel('join'); status(friendlyError(e), true); } }
})();
