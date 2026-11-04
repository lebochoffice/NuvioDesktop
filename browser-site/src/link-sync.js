// Pure sync policy for the official YouTube IFrame player. Deliberately calmer
// than the HTML5 policy (sync-policy.js): no playback-rate nudging, a wider
// seek threshold, a cooldown between corrective seeks and a hard budget per
// minute, so YouTube is never re-positioned in a loop (ads, slow buffering).
// YouTube player states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
export const LINK_SYNC = Object.freeze({
  seekPlayingS: 2,        // Drift that justifies a corrective seek while playing.
  seekPausedS: .75,       // ... while the party is paused.
  seekCooldownMs: 5000,   // No new corrective seek before YouTube settled.
  seekBudget: 3,          // Corrective seeks per window; afterwards report "behind".
  seekWindowMs: 60000,
  ownActionMs: 2000,      // State changes this soon after our own call are ours.
  endMarginS: .5,
});

export const YT = Object.freeze({UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5});

// desiredS: party position; positionS/state/durationS: from the player.
// Returns {kind: 'wait'|'in_sync'|'play'|'pause'|'seek', seconds?}.
export function youTubeAction({desiredS, positionS, partyPaused, state, durationS}) {
  if (!Number.isFinite(desiredS) || !Number.isFinite(positionS)) return {kind: 'wait'};
  // Buffering (also during ads): never seek or toggle into it.
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

// Cooldown plus budget for corrective seeks (per loaded source).
export class LinkSeekGuard {
  constructor() { this.reset(); }
  reset() { this.seeks = []; }
  prune(now) { this.seeks = this.seeks.filter(at => now - at < LINK_SYNC.seekWindowMs); }
  exhausted(now) { this.prune(now); return this.seeks.length >= LINK_SYNC.seekBudget; }
  allow(now) {
    this.prune(now);
    const last = this.seeks.at(-1);
    return this.seeks.length < LINK_SYNC.seekBudget && (last == null || now - last >= LINK_SYNC.seekCooldownMs);
  }
  note(now) { this.seeks.push(now); }
}

// A player state change that contradicts the party and was not caused by our
// own call within ownActionMs: the viewer pressed play/pause in YouTube.
export function viewerToggle({state, partyPaused, sinceOwnActionMs}) {
  if (sinceOwnActionMs < LINK_SYNC.ownActionMs || partyPaused == null) return null;
  if (state === YT.PAUSED && !partyPaused) return 'pause';
  if (state === YT.PLAYING && partyPaused) return 'play';
  return null;
}
