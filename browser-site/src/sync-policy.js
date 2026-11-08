// Pure, independently testable browser sync policy. No DOM, network, URLs or
// identities. Thresholds mirror Nuvio Desktop PartySync where a counterpart
// exists; the stall/fairness values are browser-specific (mobile networks).
export const SYNC = Object.freeze({
  seekPlayingS: 1.5,      // PartySync.SEEK_THRESHOLD_MS
  seekPausedS: .5,        // PartySync.PAUSED_TOLERANCE_MS
  nudgeStartS: .25,       // PartySync.NUDGE_START_MS
  nudgeStopS: .08,        // PartySync.NUDGE_STOP_MS (hysteresis, no rate flapping)
  nudgeFactor: .05,       // PartySync.NUDGE_FACTOR
  seekCooldownMs: 4000,   // No corrective re-seek chase while segments still load.
  stallReportMs: 2500,    // Short mobile stalls must not pause the whole party.
  readyHoldMs: 750,       // Hysteresis: stay "buffering" until playback is stable.
  waitBudget: 2,          // Party-wide waits one browser may cause per window ...
  waitWindowMs: 120000,   // ... afterwards it catches up alone ("behind").
  maxLeadS: 3,            // Upper bound for the predicted seek/load delay.
  bufferEndMarginS: .3,
});

// hls.js keeps its ABR and forward-buffer defaults (no quality cap for fast
// desktop browsers). Bounding the back buffer avoids mobile SourceBuffer quota
// evictions/stalls; prefetching the next fragment shortens recovery.
export const HLS_TUNING = Object.freeze({backBufferLength: 30, maxMaxBufferLength: 120, startFragPrefetch: true});

export function bufferedRanges(timeRanges) {
  const ranges = [];
  for (let i = 0; timeRanges && i < timeRanges.length; i++) {
    const start = timeRanges.start(i), end = timeRanges.end(i);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push([start, end]);
  }
  return ranges;
}

export function bufferAhead(ranges, time) {
  const range = ranges.find(([start, end]) => start <= time + .05 && time < end);
  return range ? Math.max(0, range[1] - time) : 0;
}

// Drift = local - desired, in seconds. Mirrors PartySync.correction.
export function correctionFor({drift, paused, nudging, rate = 1}) {
  const distance = Math.abs(drift);
  if (paused) return distance > SYNC.seekPausedS ? {kind: 'seek'} : {kind: 'in_sync', rate};
  if (distance > SYNC.seekPlayingS) return {kind: 'seek'};
  if (distance > (nudging ? SYNC.nudgeStopS : SYNC.nudgeStartS)) {
    return {kind: 'nudge', rate: Math.max(.25, Math.min(4, rate * (drift > 0 ? 1 - SYNC.nudgeFactor : 1 + SYNC.nudgeFactor)))};
  }
  return {kind: 'in_sync', rate};
}

// A buffered target is reached instantly. An unbuffered target needs a new
// segment download, during which the party continues: aim slightly ahead.
export function seekTarget({desired, paused, ranges, leadS, duration}) {
  const buffered = ranges.some(([start, end]) => start <= desired && desired < end - SYNC.bufferEndMarginS);
  const lead = paused || buffered ? 0 : Math.max(0, Math.min(SYNC.maxLeadS, Number(leadS) || 0));
  let seconds = desired + lead;
  if (Number.isFinite(duration) && duration > 0) seconds = Math.min(seconds, Math.max(0, duration - .1));
  return {seconds: Math.max(0, seconds), buffered, leadS: lead};
}

// Exponentially weighted delay between an unbuffered corrective seek and the
// resumed playback. Only plausible samples are used.
export class SeekLead {
  constructor() { this.seconds = 0; this.samples = 0; }
  observe(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 20000) return;
    const value = Math.min(SYNC.maxLeadS, ms / 1000);
    this.seconds = this.samples ? this.seconds * .7 + value * .3 : value;
    this.samples++;
  }
  reset() { this.seconds = 0; this.samples = 0; }
}

// Buffering presence with hysteresis and a per-guest fairness budget. The
// Desktop coordinator pauses everyone for "buffering"/"loading", not "behind".
export class StallTracker {
  constructor() { this.reset(); }
  reset() { this.since = null; this.stableSince = null; this.reported = false; this.waits = []; this.stalls = 0; this.selfCatchUp = false; }
  update(now, stalled) {
    if (stalled) {
      this.stableSince = null;
      if (this.since == null) { this.since = now; this.stalls++; }
      if (!this.reported && now - this.since >= SYNC.stallReportMs) {
        this.waits = this.waits.filter(at => now - at < SYNC.waitWindowMs);
        this.selfCatchUp = this.waits.length >= SYNC.waitBudget;
        if (!this.selfCatchUp) this.waits.push(now);
        this.reported = true;
      }
    } else if (this.since != null) {
      this.stableSince ??= now;
      if (!this.reported || now - this.stableSince >= SYNC.readyHoldMs) { this.since = null; this.stableSince = null; this.reported = false; this.selfCatchUp = false; }
    }
    if (!this.reported) return 'ready';
    return this.selfCatchUp ? 'behind' : 'buffering';
  }
}

const qualityLabel = height => height >= 2000 ? '4K' : `${height}p`;
// Only real, distinct variant heights. A single-variant playlist offers none.
export function qualityOptions(levels) {
  const seen = new Map();
  (levels || []).forEach((level, index) => {
    const height = Number(level?.height);
    if (!Number.isInteger(height) || height <= 0) return;
    const current = seen.get(height);
    if (!current || Number(level.bitrate) > current.bitrate) seen.set(height, {index, height, bitrate: Number(level.bitrate) || 0});
  });
  if (seen.size < 2) return [];
  return [{value: -1, label: 'Auto'}, ...[...seen.values()].sort((a, b) => b.height - a.height)
    .map(({index, height}) => ({value: index, label: qualityLabel(height)}))];
}
