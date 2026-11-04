import {isYouTubeVideoId} from './smart-video-link.js';

const API_URL = 'https://www.youtube.com/iframe_api';
const READY_TIMEOUT_MS = 15000;
let apiRequest;

function loadYouTubeApi() {
  if (typeof globalThis.YT?.Player === 'function') return Promise.resolve(globalThis.YT);
  if (apiRequest) return apiRequest;
  apiRequest = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const previous = globalThis.onYouTubeIframeAPIReady;
    const finish = api => {
      clearTimeout(timer);
      if (globalThis.onYouTubeIframeAPIReady === ready) globalThis.onYouTubeIframeAPIReady = previous;
      script.onerror = null;
      if (api) resolve(api);
      else { script.remove(); reject(new Error('youtube_api_unavailable')); }
    };
    const ready = () => finish(typeof globalThis.YT?.Player === 'function' ? globalThis.YT : null);
    const timer = setTimeout(() => finish(null), READY_TIMEOUT_MS);
    globalThis.onYouTubeIframeAPIReady = ready;
    script.onerror = () => finish(null);
    script.src = API_URL;
    script.async = true;
    document.head.append(script);
  }).catch(error => { apiRequest = undefined; throw error; });
  return apiRequest;
}

const errors = {
  2: 'Ungültiges YouTube-Video.',
  5: 'YouTube kann dieses Video in diesem Browser nicht abspielen.',
  100: 'Dieses YouTube-Video ist privat oder nicht mehr verfügbar.',
  101: 'Dieses YouTube-Video erlaubt keine Einbettung.',
  150: 'Dieses YouTube-Video erlaubt keine Einbettung.',
  153: 'YouTube konnte die eingebettete Seite nicht identifizieren.',
};

// One iframe per source. Events and pending API loads from a disposed source
// never reach the next player. Native YouTube controls remain visible.
// Implements the common player interface (player-adapters.js). onState gets
// every YouTube state change (party sync), onFailure the YouTube error code.
export class YouTubePlayerAdapter {
  constructor(mount, {origin, onStatus = () => {}, onState = () => {}, onFailure = () => {}, loadApi = loadYouTubeApi} = {}) {
    this.mount = mount;
    this.origin = origin;
    this.onStatus = onStatus;
    this.onState = onState;
    this.onFailure = onFailure;
    this.loadApi = loadApi;
    this.failed = false;
    this.generation = 0;
    this.player = null;
    this.ready = false;
    this.buffering = false;
    this.readyTimer = null;
  }

  async open(id) {
    if (!isYouTubeVideoId(id)) throw new Error('invalid_youtube_id');
    this.destroy();
    this.failed = false;
    const generation = this.generation;
    this.onStatus('YouTube-Player wird geladen …');
    try {
      const api = await this.loadApi();
      if (generation !== this.generation) return;
      const frame = this.mount.ownerDocument.createElement('iframe');
      const embed = new URL(`https://www.youtube.com/embed/${id}`);
      embed.searchParams.set('enablejsapi', '1');
      embed.searchParams.set('origin', this.origin);
      embed.searchParams.set('playsinline', '1');
      frame.title = 'YouTube-Videoplayer';
      // The page itself stays "no-referrer" (party code in the path). Only this
      // iframe request sends the page origin (never the path), which YouTube
      // needs to identify the embedding site (otherwise error 153).
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.setAttribute?.('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      frame.src = embed.href;
      this.mount.replaceChildren(frame);
      const current = fn => event => { if (generation === this.generation) fn(event); };
      this.readyTimer = setTimeout(current(() => {
        this.destroy();
        this.onStatus('Der YouTube-Player antwortet nicht. Versuche den Link erneut.');
      }), READY_TIMEOUT_MS);
      this.player = new api.Player(frame, {events: {
        onReady: current(() => {
          clearTimeout(this.readyTimer);
          this.ready = true;
          this.onStatus('YouTube bereit. Drücke Play im eingebetteten Player.');
        }),
        onStateChange: current(({data}) => {
          this.buffering = data === 3;
          if (this.buffering) this.onStatus('YouTube puffert …');
          else if (data === 1 || data === 2 || data === 0) this.onStatus('');
          this.onState(data);
        }),
        onAutoplayBlocked: current(() => { this.autoplayBlocked = true; this.onStatus('Der Browser hat den Start blockiert. Drücke Play im YouTube-Player.'); }),
        onError: current(({data}) => {
          this.destroy();
          this.failed = true;
          this.onStatus(errors[data] || 'YouTube konnte dieses Video nicht laden.');
          this.onFailure(Number.isInteger(data) ? data : null);
        }),
      }});
    } catch {
      if (generation !== this.generation) return;
      this.destroy();
      this.failed = true;
      this.onStatus('Der YouTube-Player konnte nicht geladen werden. Prüfe Verbindung oder Browser-Schutz.');
      this.onFailure(null);
    }
  }

  // Common interface: load({kind: 'youtube', videoId}).
  load(source) { return this.open(source?.videoId); }
  play() { if (this.ready) { this.autoplayBlocked = false; this.player?.playVideo(); } }
  pause() { if (this.ready) this.player?.pauseVideo(); }
  seek(seconds) {
    if (this.ready && Number.isFinite(seconds) && seconds >= 0) this.player?.seekTo(seconds, true);
  }
  get position() { return this.ready ? this.player?.getCurrentTime() ?? null : null; }
  get currentPosition() { const value = this.position; return Number.isFinite(value) ? value : null; }
  get duration() { const value = this.ready ? this.player?.getDuration() ?? null : null; return Number.isFinite(value) && value > 0 ? value : null; }
  // Raw YouTube state (-1, 0, 1, 2, 3, 5) or null before onReady.
  get state() { try { return this.ready ? this.player?.getPlayerState?.() ?? null : null; } catch { return null; } }
  get playbackState() {
    if (this.failed) return 'error';
    if (!this.player) return 'idle';
    if (!this.ready) return 'loading';
    return {0: 'ended', 1: 'playing', 2: 'paused', 3: 'playing'}[this.state] ?? 'paused';
  }
  get bufferingState() { return this.buffering; }
  dispose() { this.destroy(); }

  destroy() {
    this.generation++;
    clearTimeout(this.readyTimer);
    this.ready = this.buffering = this.autoplayBlocked = false;
    try { this.player?.destroy(); } catch { /* The iframe is still removed below. */ }
    this.player = null;
    this.mount.replaceChildren();
  }
}
