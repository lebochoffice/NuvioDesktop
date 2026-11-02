import {safeStreamUrl} from './protocol.js';
import {HLS_TUNING} from './sync-policy.js';

export function personalHlsUrlProblem(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    return 'Bitte eine gültige persönliche HTTPS-HLS-Playlist-URL eintragen.';
  }
  if (!safeStreamUrl(value.trim())) return 'Erlaubt ist nur eine öffentliche HTTPS-Playlist ohne Benutzername/Passwort im URL-Ursprung. Keine lokalen oder HTTP-Adressen.';
  if (new URL(value.trim()).hash) return 'Die Playlist-URL darf keinen Fragmentteil (#…) enthalten.';
  // TorBox playlists can have opaque paths; .m3u8 is not required.
  return '';
}

export function inspectHlsPlaylist(details) {
  if (details?.live === true) return {kind: 'live', message: 'Live-/laufende Event-Playlist erkannt (kein ENDLIST). Ihre Zeitachse entspricht nicht zuverlässig der Desktop-Filmzeit. Der Beta-Modus lädt nur abgeschlossene VOD-Playlists; Live wird gestoppt.'};
  if (details?.live !== false || details.playlistParsingError || details.iframesOnly ||
      !details.fragments?.length || !Number.isFinite(details.totalduration) || details.totalduration <= 0) {
    return {kind: 'invalid', message: 'Keine vollständige, endliche HLS-VOD-Playlist erkannt. Ein HTTP-200-Ergebnis allein bestätigt weder Format noch Wiedergabe.'};
  }
  return {kind: 'vod', duration: details.totalduration, message: 'Abgeschlossene VOD-Playlist erkannt. Codec und Suchbereich werden noch vom Browser geprüft; Wiedergabe ist damit noch nicht bestätigt.'};
}

export function vodSyncTarget(playlist, player, target) {
  if (playlist?.kind !== 'vod') return {ready: false, message: 'Für die Party-Synchronisierung ist eine abgeschlossene VOD-Playlist nötig.'};
  if (player.readyState < 1 || !Number.isFinite(player.duration) || player.duration <= 0) {
    return {ready: false, retryable: true, message: 'Warte auf endliche Videometadaten und einen suchbaren Bereich.'};
  }
  if (!Number.isFinite(target) || target < 0) return {ready: false, retryable: true, message: 'Noch keine gültige Party-Zeit empfangen.'};
  if (target > Math.min(player.duration, playlist.duration) + .25) {
    return {ready: false, message: 'Die Party-Zeit liegt außerhalb dieser VOD-Quelle. Bitte dieselbe vollständige Filmfassung wie der Host verwenden.'};
  }
  const seconds = Math.max(0, Math.min(target, player.duration - .1, playlist.duration - .1));
  const ranges = player.seekable;
  for (let i = 0; ranges && i < ranges.length; i++) {
    if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return {ready: true, seconds};
  }
  return {ready: false, retryable: true, message: 'Der benötigte Zeitpunkt ist noch nicht suchbar. Eine laufende Synchronisierung wartet und versucht es erneut; vollständiges Seek ist noch nicht bestätigt.'};
}

export function personalHlsErrorMessage(error) {
  // Never display/stringify ErrorData, URL, reason, headers or exception text.
  const code = Number(error?.response?.code ?? error?.networkDetails?.status);
  if ([401, 403].includes(code)) return 'HLS-Zugriff verweigert. Der persönliche Link kann abgelaufen sein oder ist für diesen Zugriff nicht gültig. Bitte einen neuen eigenen Link laden.';
  if ([404, 410].includes(code)) return 'HLS-Playlist oder Segment nicht mehr verfügbar. Der Link kann abgelaufen sein; bitte einen neuen eigenen Link laden.';
  if (error?.details === 'bufferStalledError') return 'Die Videopufferung ist dauerhaft ins Stocken geraten. Netzwerk und Quelle prüfen und erneut laden.';
  if (['manifestIncompatibleCodecsError', 'bufferAddCodecError', 'fragParsingError', 'fragDecryptError'].includes(error?.details)) {
    return 'HLS-Medienfehler: Codec, Segmentformat oder Verschlüsselung ist im Browser nicht verwendbar. Eine andere browserkompatible eigene Quelle wählen.';
  }
  if (error?.details === 'manifestParsingError') return 'Die Antwort ist keine verwendbare HLS-Playlist. Möglich sind ein ungültiger oder abgelaufener Link bzw. eine Fehlerseite statt des Manifests.';
  if (error?.type === 'mediaError') return 'HLS-Medienfehler: Die Wiedergabe konnte nicht fortgesetzt werden. Möglich sind Codec-, Segment- oder Pufferprobleme; die genaue Ursache ist nicht bestätigt. Bitte erneut laden oder eine kompatible Quelle wählen.';
  return 'HLS-Netzwerkfehler: Playlist, Segmente oder Schlüssel konnten nicht geladen werden. HTTPS, CORS und Gültigkeit des persönlichen Links prüfen. Der Browser nennt die Ursache möglicherweise nicht genauer.';
}

// Private, in-memory media transport only. No PartySession, storage, telemetry
// or console access. Callbacks expose fixed messages/playlist kind, never URLs.
export class PersonalHlsSource {
  constructor(Hls, player, {onPlaylist = () => {}, onError = () => {}, onInternalSeek = () => {}, onInstance = () => {}} = {}) {
    this.Hls = Hls; this.player = player; this.onPlaylist = onPlaylist; this.onError = onError;
    this.onInternalSeek = onInternalSeek; this.onInstance = onInstance;
    this.active = false; this.mediaKey = null; this.playlist = null; this.instance = null;
  }
  open(value, mediaKey) {
    const problem = personalHlsUrlProblem(value);
    if (problem) return problem;
    if (typeof mediaKey !== 'string' || !mediaKey.trim()) return 'Die Party hat noch keine gültige Filmkennung. Bitte den Host prüfen und erneut laden.';
    this.clear(); this.active = true; this.mediaKey = mediaKey;
    try {
      if (!this.Hls.isSupported()) {
        this.fail('Dieser Browser unterstützt den für diesen Beta-Modus benötigten hls.js-/Media-Source-Player nicht. Die normale Desktop-Wiedergabe bleibt verfügbar.');
        return '';
      }
      const instance = new this.Hls({
        ...HLS_TUNING,
        debug: false,
        enableWorker: true,
        // Also applies to relative segments after hls.js resolves their URLs.
        // Do not copy query tokens onto other URLs or add custom auth headers.
        xhrSetup: (xhr, requestUrl) => {
          if (!safeStreamUrl(requestUrl)) throw new Error('HLS requires public HTTPS media URLs');
          xhr.withCredentials = false;
        },
      });
      this.instance = instance;
      // Quality/diagnostic listeners only; they receive the instance, no URL.
      this.onInstance(instance);
      instance.on(this.Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (this.instance !== instance) return;
        this.playlist = inspectHlsPlaylist(data?.details);
        if (this.playlist.kind !== 'vod') { this.fail(this.playlist.message); return; }
        this.onPlaylist(this.playlist);
      });
      instance.on(this.Hls.Events.ERROR, (_event, error) => {
        if (this.instance !== instance) return;
        // These events are emitted after hls.js adjusts currentTime, before
        // the browser dispatches seeking. Expose only the numeric target.
        if (!error?.fatal && ['bufferSeekOverHole', 'bufferNudgeOnStall'].includes(error?.details)) {
          this.onInternalSeek(this.player.currentTime);
        }
        const code = Number(error?.response?.code ?? error?.networkDetails?.status);
        if (this.instance === instance && (error?.fatal || [401, 403, 404, 410].includes(code))) {
          this.fail(personalHlsErrorMessage(error));
        }
      });
      // hls.js resolves variant playlists, keys and relative .ts segments from
      // their actual playlist URL; no custom fetch, proxy or remux is involved.
      instance.loadSource(value.trim());
      instance.attachMedia(this.player);
    } catch { this.fail('Die persönliche HLS-Quelle konnte nicht geöffnet werden. HTTPS, Browser-Unterstützung und Gültigkeit des Links prüfen.'); }
    return '';
  }
  syncTarget(target) { return vodSyncTarget(this.playlist, this.player, target); }
  dispose() {
    const instance = this.instance; this.instance = null;
    if (instance) { try { instance.destroy(); } catch { /* Never log URL-bearing exceptions. */ } }
  }
  fail(message) {
    this.dispose(); this.playlist = null;
    // Keep the manual-source selection active even after a failure: a Desktop
    // broadcast must not unexpectedly replace the user's private source.
    this.onError(message);
  }
  clear() {
    this.dispose(); this.active = false; this.mediaKey = null; this.playlist = null;
  }
}
