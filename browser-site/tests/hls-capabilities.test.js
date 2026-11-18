import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {detectHlsCapabilities, selectHlsPlayback} from '../src/hls-capabilities.js';

const scope = ({media = true, managed = false, fetch = true} = {}) => ({
  ...(media ? {MediaSource: class MediaSource {}} : {}),
  ...(managed ? {ManagedMediaSource: class ManagedMediaSource {}} : {}),
  ...(fetch ? {fetch() {}, AbortController: class {}, ReadableStream: class {}, Request: class {}} : {}),
});
const media = native => ({canPlayType: () => native ? 'maybe' : ''});
const hls = (supported, source = null) => ({isSupported: () => supported, getMediaSource: () => source});

test('Chromium, Firefox and Android use the common hls.js path when MSE is supported', () => {
  for (const name of ['Chrome', 'Edge', 'Firefox', 'Android Chrome', 'Android Firefox']) {
    const env = scope(), caps = detectHlsCapabilities(hls(true, env.MediaSource), media(false), env);
    assert.equal(caps.hlsJs, true, name);
    assert.equal(selectHlsPlayback(caps), 'hlsjs', name);
    assert.equal(selectHlsPlayback(caps, {protectedFamily: true}), 'hlsjs', name);
  }
});

test('Safari uses native HLS for public media and hls.js with MSE/MMS for protected Family-HLS', () => {
  const mac = scope(), macCaps = detectHlsCapabilities(hls(true, mac.MediaSource), media(true), mac);
  assert.equal(selectHlsPlayback(macCaps), 'native');
  assert.equal(selectHlsPlayback(macCaps, {protectedFamily: true}), 'hlsjs');

  const ios = scope({media: false, managed: true});
  const iosCaps = detectHlsCapabilities(hls(true, ios.ManagedMediaSource), media(true), ios);
  assert.equal(iosCaps.managedMediaSource, true);
  assert.equal(selectHlsPlayback(iosCaps), 'native');
  assert.equal(selectHlsPlayback(iosCaps, {protectedFamily: true}), 'hlsjs');
});

test('native-only iOS and Smart-TV browsers fail protected Family-HLS clearly but retain public HLS', () => {
  const env = scope({media: false, fetch: false});
  const caps = detectHlsCapabilities(hls(false), media(true), env);
  assert.equal(selectHlsPlayback(caps), 'native');
  assert.equal(selectHlsPlayback(caps, {protectedFamily: true}), 'unsupported-protected');
});

test('protected Family-HLS rejects an MSE browser without the checked streaming Fetch loader', () => {
  const env = scope({fetch: false}), caps = detectHlsCapabilities(hls(true, env.MediaSource), media(false), env);
  assert.equal(caps.hlsJs, true);
  assert.equal(caps.streamingFetch, false);
  assert.equal(selectHlsPlayback(caps, {protectedFamily: true}), 'unsupported-protected');
  assert.equal(selectHlsPlayback(caps), 'hlsjs');
});

test('a browser without native HLS or MSE reports unsupported instead of selecting a fake path', () => {
  const env = scope({media: false}), caps = detectHlsCapabilities(hls(false), media(false), env);
  assert.equal(selectHlsPlayback(caps), 'unsupported');
  assert.equal(selectHlsPlayback(caps, {requestHeaders: true}), 'unsupported-headers');
});
