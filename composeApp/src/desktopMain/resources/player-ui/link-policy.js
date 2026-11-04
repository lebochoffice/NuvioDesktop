// Sync policy for shared party videos in the NUVIO Desktop player view.
// Same rules as browser-site/src/link-sync.js (checked by
// browser-site/tests/desktop-link-player.test.js), plus calm rate nudging for
// direct files. Pure: no DOM, no network. Exposed as globalThis.NuvioLinkPolicy.
(() => {
  const LINK_SYNC = Object.freeze({
    seekPlayingS: 2, seekPausedS: .75, seekCooldownMs: 5000, seekBudget: 3, seekWindowMs: 60000, ownActionMs: 2000, endMarginS: .5,
  });
  // Direct MP4/WebM in the HTML5 player: tighter, with hysteresis nudging (like PartySync).
  const FILE_SYNC = Object.freeze({
    seekPlayingS: 1.5, seekPausedS: .5, seekCooldownMs: 3000, seekBudget: 5, nudgeStartS: .25, nudgeStopS: .08, nudgeFactor: .05,
  });
  const YT = Object.freeze({UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5});

  // Party time in ms: position + (serverNow - at) * rate while playing.
  const partyPositionMs = (state, serverNowMs) => !state ? null
    : Math.max(0, Math.trunc(Number(state.positionMs) + (state.paused ? 0 : Math.max(0, serverNowMs - Number(state.at)) * Number(state.rate || 1))));

  function youTubeAction({desiredS, positionS, partyPaused, state, durationS}) {
    if (!Number.isFinite(desiredS) || !Number.isFinite(positionS)) return {kind: 'wait'};
    if (state === YT.BUFFERING) return {kind: 'wait'};
    let desired = Math.max(0, desiredS);
    const duration = Number.isFinite(durationS) && durationS > 0 ? durationS : null;
    if (duration) desired = Math.min(desired, Math.max(0, duration - LINK_SYNC.endMarginS));
    if (state === YT.ENDED && (partyPaused || (duration && desiredS >= duration - 1))) return {kind: 'in_sync'};
    const drift = positionS - desired;
    if (Math.abs(drift) > (partyPaused ? LINK_SYNC.seekPausedS : LINK_SYNC.seekPlayingS)) return {kind: 'seek', seconds: desired};
    if (partyPaused && state === YT.PLAYING) return {kind: 'pause'};
    if (!partyPaused && [YT.PAUSED, YT.CUED, YT.UNSTARTED, YT.ENDED].includes(state)) return {kind: 'play'};
    return {kind: 'in_sync'};
  }

  // HTML5 file: {kind, seconds?, rate}. buffering: the element waits for data.
  function fileAction({desiredS, positionS, partyPaused, playing, buffering, durationS, nudging, rate = 1}) {
    if (!Number.isFinite(desiredS) || !Number.isFinite(positionS) || buffering) return {kind: 'wait', rate: 1};
    let desired = Math.max(0, desiredS);
    if (Number.isFinite(durationS) && durationS > 0) desired = Math.min(desired, Math.max(0, durationS - .1));
    const drift = positionS - desired, distance = Math.abs(drift);
    if (distance > (partyPaused ? FILE_SYNC.seekPausedS : FILE_SYNC.seekPlayingS)) return {kind: 'seek', seconds: desired, rate: 1};
    if (partyPaused) return {kind: playing ? 'pause' : 'in_sync', rate: 1};
    if (!playing) return {kind: 'play', rate: 1};
    if (distance > (nudging ? FILE_SYNC.nudgeStopS : FILE_SYNC.nudgeStartS)) {
      return {kind: 'nudge', rate: Math.max(.25, Math.min(4, rate * (drift > 0 ? 1 - FILE_SYNC.nudgeFactor : 1 + FILE_SYNC.nudgeFactor)))};
    }
    return {kind: 'in_sync', rate};
  }

  class LinkSeekGuard {
    constructor(cooldownMs = LINK_SYNC.seekCooldownMs, budget = LINK_SYNC.seekBudget) { this.cooldownMs = cooldownMs; this.budget = budget; this.reset(); }
    reset() { this.seeks = []; }
    prune(now) { this.seeks = this.seeks.filter(at => now - at < LINK_SYNC.seekWindowMs); }
    exhausted(now) { this.prune(now); return this.seeks.length >= this.budget; }
    allow(now) {
      this.prune(now);
      const last = this.seeks[this.seeks.length - 1];
      return this.seeks.length < this.budget && (last == null || now - last >= this.cooldownMs);
    }
    note(now) { this.seeks.push(now); }
  }

  function viewerToggle({state, partyPaused, sinceOwnActionMs}) {
    if (sinceOwnActionMs < LINK_SYNC.ownActionMs || partyPaused == null) return null;
    if (state === YT.PAUSED && !partyPaused) return 'pause';
    if (state === YT.PLAYING && partyPaused) return 'play';
    return null;
  }

  const isYouTubeVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  // Public HTTPS file address only (same rules as the browser's safeStreamUrl).
  function safeFileUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash || !/\.(?:mp4|webm)$/i.test(u.pathname)) return false;
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host) || host === 'home.arpa') return false;
      if (host.includes(':')) return /^(?:2|3)[0-9a-f]{0,3}:/i.test(host);
      const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (m && (+m[1] === 0 || +m[1] === 10 || +m[1] === 127 || +m[1] >= 224 || (+m[1] === 169 && +m[2] === 254) || (+m[1] === 192 && +m[2] === 168) ||
        (+m[1] === 172 && +m[2] >= 16 && +m[2] <= 31) || (+m[1] === 100 && +m[2] >= 64 && +m[2] <= 127))) return false;
      return true;
    } catch { return false; }
  }

  globalThis.NuvioLinkPolicy = Object.freeze({LINK_SYNC, FILE_SYNC, YT, partyPositionMs, youTubeAction, fileAction, LinkSeekGuard, viewerToggle, isYouTubeVideoId, safeFileUrl});
})();
