// Slim common player interface for the party page:
//   load(source) · play() · pause() · seek(seconds) · currentPosition ·
//   duration · playbackState · bufferingState · dispose()
// playbackState: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'.
// bufferingState: true while the player waits for data.
// Implementations: VideoElementAdapter (the page's HTML5 <video>; HLS through
// the existing hls.js path, MP4/WebM natively) and YouTubePlayerAdapter
// (youtube-player.js, official IFrame Player API).
export const PLAYER_ADAPTER_MEMBERS = Object.freeze(['load', 'play', 'pause', 'seek', 'currentPosition', 'duration', 'playbackState', 'bufferingState', 'dispose']);
export const isPlayerAdapter = adapter => !!adapter && PLAYER_ADAPTER_MEMBERS.every(name => name in adapter);

// Wraps an existing <video> element without taking it over: the proven
// HTML5/HLS sync (applySync, hls.js setup, stall tracking) keeps driving the
// element directly; this adapter gives the rest of the page the common view.
// load(source) is the native path for progressive MP4/WebM only; HLS stays
// with the existing hls.js loader.
export class VideoElementAdapter {
  constructor(video) { this.video = video; this.error = false; video.addEventListener?.('error', () => { this.error = true; }); video.addEventListener?.('emptied', () => { this.error = false; }); }
  load(source) {
    if (!source || !['mp4', 'webm'].includes(source.kind) || typeof source.url !== 'string') throw new Error('unsupported_source');
    this.error = false;
    this.video.src = source.url;
  }
  play() { return Promise.resolve(this.video.play()); }
  pause() { this.video.pause(); }
  seek(seconds) { if (Number.isFinite(seconds) && seconds >= 0) this.video.currentTime = seconds; }
  get currentPosition() { const t = this.video.currentTime; return this.video.readyState >= 1 && Number.isFinite(t) ? t : null; }
  get duration() { const d = this.video.duration; return Number.isFinite(d) && d > 0 ? d : null; }
  get playbackState() {
    const v = this.video;
    if (this.error) return 'error';
    if (!v.currentSrc && !v.src) return 'idle';
    if (v.readyState < 1) return 'loading';
    if (v.ended) return 'ended';
    return v.paused ? 'paused' : 'playing';
  }
  get bufferingState() { const v = this.video; return !!(v.currentSrc || v.src) && !v.paused && v.readyState < 3; }
  dispose() { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
}
