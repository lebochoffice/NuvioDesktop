const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegURL'];

function supportsStreamingFetch(scope) {
  if (!scope?.fetch || !scope.AbortController || !scope.ReadableStream || !scope.Request) return false;
  try { new scope.ReadableStream({}); return true; }
  catch { return false; }
}

// Capability-only detection: browser names and user-agent strings are
// deliberately irrelevant. Hls.isSupported() already validates MSE/MMS,
// SourceBuffer and at least one baseline codec through isTypeSupported().
export function detectHlsCapabilities(HlsClass, media, scope = globalThis) {
  let nativeHls = false, hlsJs = false, selectedMediaSource = null;
  try { nativeHls = HLS_TYPES.some(type => !!media?.canPlayType?.(type)); } catch { /* Unsupported media element. */ }
  try { hlsJs = HlsClass?.isSupported?.() === true; } catch { /* Unsupported MSE/MMS implementation. */ }
  try { selectedMediaSource = HlsClass?.getMediaSource?.() || null; } catch { /* Older hls.js or browser. */ }
  selectedMediaSource ||= scope?.ManagedMediaSource || scope?.MediaSource || scope?.WebKitMediaSource || null;
  return Object.freeze({
    nativeHls,
    hlsJs,
    streamingFetch: supportsStreamingFetch(scope),
    mediaSource: !!selectedMediaSource,
    managedMediaSource: !!scope?.ManagedMediaSource && selectedMediaSource === scope.ManagedMediaSource,
  });
}

// Native HLS is preferred for ordinary public streams. Protected Family-HLS
// must keep every playlist/segment request inside the checked Fetch loader;
// native HLS and an XHR-only hls.js path cannot enforce that contract.
export function selectHlsPlayback(capabilities, {protectedFamily = false, requestHeaders = false} = {}) {
  if (protectedFamily) return capabilities.hlsJs && capabilities.streamingFetch ? 'hlsjs' : 'unsupported-protected';
  if (!requestHeaders && capabilities.nativeHls) return 'native';
  if (capabilities.hlsJs) return 'hlsjs';
  return requestHeaders ? 'unsupported-headers' : 'unsupported';
}
