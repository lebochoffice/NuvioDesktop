// Shared party video inside the NUVIO Desktop player view: the official
// YouTube IFrame player or an HTML5 <video> for direct MP4/WebM files.
// The parent (player overlay, party.js) sends the source and the raw party
// state; this page follows the party time with link-policy.js and reports
// status, position and the viewer's own play/pause back. No extraction, no
// download, no ad or DRM workaround; YouTube's own controls stay visible.
(() => {
  'use strict';
  const P = globalThis.NuvioLinkPolicy;
  const mount = document.getElementById('player');
  const statusEl = document.getElementById('status');
  const API_URL = 'https://www.youtube.com/iframe_api';
  const READY_TIMEOUT_MS = 15000;
  const VIEWER_HOLD_MS = 1500;
  const YT_ERRORS = {
    2: 'Ungültiges YouTube-Video.', 5: 'YouTube kann dieses Video hier nicht abspielen.',
    100: 'Dieses YouTube-Video ist privat oder nicht mehr verfügbar.', 101: 'Dieses YouTube-Video erlaubt keine Einbettung.',
    150: 'Dieses YouTube-Video erlaubt keine Einbettung.', 153: 'YouTube konnte die eingebettete Seite nicht identifizieren.',
  };
  let source = null, party = null, solo = false, guard = null, generation = 0;
  let own = -Infinity, holdUntil = -Infinity, behind = false, nudging = false;
  let yt = null, ytReady = false, ytBlocked = false, video = null, apiRequest = null;

  const post = message => { try { window.parent.postMessage({nuvioLink: 1, ...message}, '*'); } catch { /* Parent gone. */ } };
  const say = (status, message = '') => { statusEl.textContent = message; post({type: 'status', status, message}); };
  const now = () => performance.now();
  const serverNow = () => Date.now() + (Number(party?.offsetMs) || 0);

  function loadApi() {
    if (typeof globalThis.YT?.Player === 'function') return Promise.resolve(globalThis.YT);
    if (apiRequest) return apiRequest;
    apiRequest = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
      globalThis.onYouTubeIframeAPIReady = () => { clearTimeout(timer); typeof globalThis.YT?.Player === 'function' ? resolve(globalThis.YT) : reject(new Error('api')); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('load')); };
      script.src = API_URL; script.async = true;
      document.head.append(script);
    }).catch(error => { apiRequest = null; throw error; });
    return apiRequest;
  }

  function dispose() {
    generation++;
    try { yt?.destroy(); } catch { /* The iframe is removed below. */ }
    yt = null; ytReady = false; ytBlocked = false;
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    video = null;
    mount.replaceChildren();
    own = holdUntil = -Infinity; behind = false; nudging = false;
  }

  function load(next) {
    if (!next || typeof next.key !== 'string') { dispose(); source = null; say('idle'); return; }
    if (next.key === source?.key) return; // Re-sent unchanged: no reload.
    dispose();
    source = next; party = null;
    guard = next.kind === 'youtube' ? new P.LinkSeekGuard() : new P.LinkSeekGuard(P.FILE_SYNC.seekCooldownMs, P.FILE_SYNC.seekBudget);
    if (next.kind === 'youtube') openYouTube(next.videoId);
    else if ((next.kind === 'mp4' || next.kind === 'webm') && P.safeFileUrl(next.url)) openFile(next.url);
    else say('error', 'Diese Quelle wird nicht unterstützt.');
  }

  async function openYouTube(id) {
    if (!P.isYouTubeVideoId(id)) { say('error', YT_ERRORS[2]); return; }
    const current = generation;
    say('loading', 'YouTube-Player wird geladen …');
    let api;
    try { api = await loadApi(); } catch { if (current === generation) say('error', 'Der YouTube-Player konnte nicht geladen werden. Verbindung prüfen.'); return; }
    if (current !== generation) return;
    const frame = document.createElement('iframe');
    const embed = new URL(`https://www.youtube.com/embed/${id}`);
    embed.searchParams.set('enablejsapi', '1');
    embed.searchParams.set('origin', location.origin);
    embed.searchParams.set('playsinline', '1');
    frame.title = 'YouTube-Videoplayer';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.src = embed.href;
    mount.replaceChildren(frame);
    const live = fn => (...args) => { if (current === generation) fn(...args); };
    const readyTimer = setTimeout(live(() => say('error', 'Der YouTube-Player antwortet nicht.')), READY_TIMEOUT_MS);
    yt = new api.Player(frame, {events: {
      onReady: live(() => { clearTimeout(readyTimer); ytReady = true; say('ready'); sync(); }),
      onStateChange: live(({data}) => youTubeState(data)),
      onAutoplayBlocked: live(() => { ytBlocked = true; say('blocked', 'Automatischer Start blockiert. Drücke Play im YouTube-Player.'); }),
      onError: live(({data}) => { clearTimeout(readyTimer); ytReady = false; say('error', YT_ERRORS[data] || 'YouTube konnte dieses Video nicht laden.'); }),
    }});
  }

  function openFile(url) {
    const current = generation;
    const element = video = document.createElement('video');
    element.playsInline = true; element.preload = 'auto'; element.controls = false;
    const live = fn => () => { if (current === generation) fn(); };
    element.addEventListener('loadedmetadata', live(() => { say('ready'); sync(); }));
    element.addEventListener('waiting', live(() => say('buffering', 'Video puffert …')));
    element.addEventListener('playing', live(() => say('ready')));
    element.addEventListener('canplay', live(() => sync()));
    element.addEventListener('error', live(() => say('error', 'Video nicht abspielbar: Format, Codec, abgelaufener Link oder fehlende Zugriffsrechte.')));
    say('loading', 'Video wird geladen …');
    mount.replaceChildren(element);
    element.src = url;
  }

  function youTubeState(state) {
    if (state === P.YT.BUFFERING) say('buffering', 'YouTube puffert …');
    else if (state === P.YT.PLAYING || state === P.YT.PAUSED) { if (state === P.YT.PLAYING) ytBlocked = false; say(behind ? 'behind' : 'ready'); }
    if (solo || !party) return;
    const toggle = P.viewerToggle({state, partyPaused: party.paused, sinceOwnActionMs: now() - own});
    if (toggle) {
      holdUntil = now() + VIEWER_HOLD_MS; // Do not undo the viewer's action before the party answers.
      post({type: 'viewer', action: toggle, positionMs: Math.round((yt.getCurrentTime() || 0) * 1000)});
      return;
    }
    sync();
  }

  function sync() {
    if (!source || !party || party.key !== source.key || solo || now() < holdUntil) return;
    const t = now(), desiredS = P.partyPositionMs(party, serverNow()) / 1000;
    const tooOften = () => {
      if (guard.exhausted(t) && !behind) { behind = true; say('behind', 'Holt die Party-Zeit gerade nicht ein (z. B. Werbung oder langsames Laden). Gleich neuer Versuch.'); }
    };
    if (yt) {
      if (!ytReady) return;
      const action = P.youTubeAction({desiredS, positionS: yt.getCurrentTime(), partyPaused: party.paused, state: yt.getPlayerState(), durationS: yt.getDuration()});
      if (action.kind === 'seek') {
        if (!guard.allow(t)) { tooOften(); return; }
        behind = false; guard.note(t); own = t;
        yt.seekTo(action.seconds, true);
        if (!party.paused && !ytBlocked) yt.playVideo();
      } else if (action.kind === 'play') { if (!ytBlocked) { own = t; yt.playVideo(); } }
      else if (action.kind === 'pause') { own = t; yt.pauseVideo(); }
      else if (action.kind === 'in_sync' && behind) { behind = false; say('ready'); }
      return;
    }
    if (!video || video.readyState < 1) return;
    const rate = Number(party.rate) || 1;
    const action = P.fileAction({desiredS, positionS: video.currentTime, partyPaused: party.paused, playing: !video.paused,
      buffering: !video.paused && video.readyState < 3, durationS: video.duration, nudging, rate});
    if (action.kind === 'seek') {
      if (!guard.allow(t)) { tooOften(); return; }
      behind = false; guard.note(t); own = t;
      video.currentTime = action.seconds;
      if (!party.paused) play();
    } else if (action.kind === 'play') play();
    else if (action.kind === 'pause') { own = t; video.pause(); }
    else if (behind && action.kind !== 'wait') { behind = false; say('ready'); }
    nudging = action.kind === 'nudge';
    const nextRate = nudging ? action.rate : rate;
    if (video.playbackRate !== nextRate) video.playbackRate = nextRate;
  }

  function play() {
    own = now();
    Promise.resolve(video.play()).catch(error => {
      if (error?.name !== 'NotAllowedError' || video.muted) return;
      video.muted = true; // Autoplay rule: start without sound, the viewer can unmute.
      Promise.resolve(video.play()).then(() => say('ready', 'Stumm gestartet. Ton über den Lautstärkeregler des Systems oder mit Klick aufs Video.')).catch(() => {});
    });
  }

  // Solo ("Allein schauen") only: local control without the party.
  function local(action, seconds) {
    if (yt && ytReady) {
      if (action === 'toggle') yt.getPlayerState() === P.YT.PLAYING ? yt.pauseVideo() : yt.playVideo();
      else if (action === 'seekBy') yt.seekTo(Math.max(0, yt.getCurrentTime() + seconds), true);
    } else if (video) {
      if (action === 'toggle') video.paused ? play() : video.pause();
      else if (action === 'seekBy') video.currentTime = Math.max(0, video.currentTime + seconds);
    }
  }

  mount.addEventListener('click', () => { if (video?.muted) video.muted = false; });
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.nuvioLink !== 1) return;
    if (data.type === 'source') load(data.source);
    else if (data.type === 'party') { party = data.party && data.party.key === source?.key ? data.party : null; sync(); }
    else if (data.type === 'solo') {
      solo = data.solo === true;
      if (!solo) { guard?.reset(); own = holdUntil = -Infinity; behind = false; sync(); }
      post({type: 'status', status: solo ? 'solo' : 'ready', message: ''});
    } else if (data.type === 'local' && solo) local(data.action, Number(data.seconds) || 0);
  });
  setInterval(() => {
    sync();
    const position = yt && ytReady ? yt.getCurrentTime() : video && video.readyState >= 1 ? video.currentTime : null;
    if (Number.isFinite(position)) {
      const playing = yt ? yt.getPlayerState() === P.YT.PLAYING : !video.paused;
      const duration = yt ? yt.getDuration() : video.duration;
      post({type: 'position', positionMs: Math.round(position * 1000), playing, durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null});
    }
  }, 1000);
  post({type: 'hello'});
})();
