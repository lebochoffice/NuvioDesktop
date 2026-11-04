import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {parseSharedSource, suggestionFields, sharedFileStream, sharedSourceKey, isSharedSourceKey} from '../src/shared-source.js';
import {streamProblem, streamIsHls} from '../src/protocol.js';
import {classifyVideoLink} from '../src/smart-video-link.js';
import {LINK_SYNC, YT, LinkSeekGuard, youTubeAction, viewerToggle} from '../src/link-sync.js';
import {VideoElementAdapter, isPlayerAdapter} from '../src/player-adapters.js';
import {YouTubePlayerAdapter} from '../src/youtube-player.js';

const party = 'movie|tt1||', id = 'abcdefgh23456789';
const base = (kind, extra = {}) => ({key: sharedSourceKey(id, 2), id, rev: 2, kind, party_key: party, label: 'Clip', ...extra});

test('shared sources: YouTube by ID only, files by public HTTPS address of the stated kind', () => {
  assert.deepEqual(parseSharedSource(base('youtube', {video_id: 'M7lc1UVf-VE'}), party),
    {key: `link:${id}:2`, id, rev: 2, kind: 'youtube', videoId: 'M7lc1UVf-VE', label: 'Clip'});
  assert.equal(parseSharedSource(base('mp4', {url: 'https://cdn.example.test/a.mp4?sig=x'}), party).url, 'https://cdn.example.test/a.mp4?sig=x');
  assert.equal(parseSharedSource(base('webm', {url: 'https://cdn.example.test/a.webm'}), party).kind, 'webm');
  for (const bad of [
    base('youtube', {video_id: '../x'}), base('youtube', {video_id: 'M7lc1UVf-VE', url: 'https://evil.test/a.mp4'}),
    base('mp4', {url: 'https://cdn.example.test/a.webm'}), base('mp4', {url: 'http://cdn.example.test/a.mp4'}),
    base('mp4', {url: 'https://192.168.1.2/a.mp4'}), base('mp4', {url: 'https://localhost/a.mp4'}),
    base('mp4', {url: 'https://user:pw@cdn.example.test/a.mp4'}), base('mp4', {url: 'https://cdn.example.test/a.mp4#t=1'}),
    base('hls', {url: 'https://cdn.example.test/a.m3u8'}), base('mp4', {url: 'https://cdn.example.test/a.mp4', key: `link:${id}:1`}),
    base('mp4', {url: 'https://cdn.example.test/a.mp4', party_key: 'movie|tt2||'}), {...base('mp4', {url: 'https://cdn.example.test/a.mp4'}), rev: 0},
    {...base('mp4', {url: 'https://cdn.example.test/a.mp4'}), id: 'x'}, null, [], 'link',
  ]) assert.equal(parseSharedSource(bad, party), null, JSON.stringify(bad));
  assert.equal(parseSharedSource(base('youtube', {video_id: 'M7lc1UVf-VE', label: 'A\u0000B'.padEnd(200, 'c')}), party).label.length, 80);
  assert.equal(isSharedSourceKey(`link:${id}:2`), true); assert.equal(isSharedSourceKey(party), false);
});

test('proposals: YouTube becomes a canonical address without tracking; files keep their signed URL', () => {
  const yt = classifyVideoLink('https://youtu.be/M7lc1UVf-VE?si=tracking&t=42');
  assert.deepEqual(suggestionFields(yt), {kind: 'youtube', video_id: 'M7lc1UVf-VE', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE'});
  assert.deepEqual(suggestionFields(classifyVideoLink('https://cdn.example.test/a.mp4?sig=1')), {kind: 'mp4', url: 'https://cdn.example.test/a.mp4?sig=1'});
  assert.equal(suggestionFields(classifyVideoLink('https://cdn.example.test/a.mkv')), null);
});

test('a shared file is a normal progressive stream for the HTML5 path, never HLS', () => {
  const source = parseSharedSource(base('mp4', {url: 'https://cdn.example.test/a.mp4'}), party);
  const stream = sharedFileStream(source);
  assert.equal(stream.media_key, `link:${id}:2`); assert.equal(streamProblem(stream), ''); assert.equal(streamIsHls(stream), false);
  assert.deepEqual(stream.headers, {}); // No Authorization or other request headers.
});

test('YouTube policy: waits while buffering, seeks only beyond the threshold, toggles play/pause', () => {
  const a = (state, positionS, desiredS = 100, partyPaused = false, durationS = 600) => youTubeAction({desiredS, positionS, partyPaused, state, durationS});
  assert.deepEqual(a(YT.BUFFERING, 0), {kind: 'wait'}); // Ads/buffering: never fight it.
  assert.deepEqual(a(YT.PLAYING, 101.5), {kind: 'in_sync'}); // Within 2 s: no seek, no rate nudging.
  assert.deepEqual(a(YT.PLAYING, 103), {kind: 'seek', seconds: 100});
  assert.deepEqual(a(YT.PAUSED, 100.5, 100, true), {kind: 'in_sync'});
  assert.deepEqual(a(YT.PAUSED, 101, 100, true), {kind: 'seek', seconds: 100});
  assert.deepEqual(a(YT.PLAYING, 100, 100, true), {kind: 'pause'});
  for (const state of [YT.PAUSED, YT.CUED, YT.UNSTARTED]) assert.deepEqual(a(state, 100), {kind: 'play'});
  assert.deepEqual(a(YT.PLAYING, 590, 900), {kind: 'seek', seconds: 600 - LINK_SYNC.endMarginS}); // Clamped to the end.
  assert.deepEqual(a(YT.ENDED, 600, 900), {kind: 'in_sync'});
  assert.deepEqual(youTubeAction({desiredS: NaN, positionS: 1, partyPaused: false, state: YT.PLAYING}), {kind: 'wait'});
});

test('corrective seeks have a cooldown and a budget per minute (no seek loop)', () => {
  const guard = new LinkSeekGuard();
  assert.equal(guard.allow(0), true); guard.note(0);
  assert.equal(guard.allow(LINK_SYNC.seekCooldownMs - 1), false);
  for (let i = 1; i < LINK_SYNC.seekBudget; i++) { const at = i * LINK_SYNC.seekCooldownMs; assert.equal(guard.allow(at), true); guard.note(at); }
  const later = LINK_SYNC.seekBudget * LINK_SYNC.seekCooldownMs;
  assert.equal(guard.allow(later), false); assert.equal(guard.exhausted(later), true);
  assert.equal(guard.allow(LINK_SYNC.seekWindowMs + 1), true); // The window passed.
});

test('viewer play/pause is recognised only when it contradicts the party and is not our own call', () => {
  assert.equal(viewerToggle({state: YT.PAUSED, partyPaused: false, sinceOwnActionMs: 5000}), 'pause');
  assert.equal(viewerToggle({state: YT.PLAYING, partyPaused: true, sinceOwnActionMs: 5000}), 'play');
  assert.equal(viewerToggle({state: YT.PAUSED, partyPaused: false, sinceOwnActionMs: 100}), null); // Our own pause.
  assert.equal(viewerToggle({state: YT.BUFFERING, partyPaused: false, sinceOwnActionMs: 5000}), null);
  assert.equal(viewerToggle({state: YT.PLAYING, partyPaused: null, sinceOwnActionMs: 5000}), null); // No party time yet.
});

test('both adapters implement the common player interface', async () => {
  const listeners = {};
  const video = {currentTime: 12, duration: 60, readyState: 4, paused: false, ended: false, src: '', currentSrc: '',
    addEventListener: (name, fn) => { listeners[name] = fn; }, play: async () => {}, pause() { this.paused = true; },
    removeAttribute(name) { this[name] = ''; }, load() {}};
  const element = new VideoElementAdapter(video);
  assert.equal(isPlayerAdapter(element), true);
  assert.equal(element.playbackState, 'idle');
  element.load({kind: 'mp4', url: 'https://cdn.example.test/a.mp4'});
  assert.equal(element.playbackState, 'playing'); assert.equal(element.currentPosition, 12); assert.equal(element.duration, 60);
  assert.throws(() => element.load({kind: 'hls', url: 'https://cdn.example.test/a.m3u8'})); // HLS stays with hls.js.
  element.seek(30); assert.equal(video.currentTime, 30); element.seek(-1); assert.equal(video.currentTime, 30);
  listeners.error(); assert.equal(element.playbackState, 'error');
  element.dispose(); assert.equal(video.paused, true);
  const mount = {children: [], ownerDocument: {createElement: () => ({})}, replaceChildren(...c) { this.children = c; }};
  const youtube = new YouTubePlayerAdapter(mount, {origin: 'https://watch.example.test', loadApi: async () => ({Player: class {
    constructor(_f, {events}) { this.events = events; } getCurrentTime() { return 5; } getDuration() { return 0; } getPlayerState() { return 2; } destroy() {}
  }})});
  assert.equal(isPlayerAdapter(youtube), true);
  assert.equal(youtube.playbackState, 'idle');
  await youtube.load({kind: 'youtube', videoId: 'M7lc1UVf-VE'});
  assert.equal(youtube.playbackState, 'loading');
  youtube.player.events.onReady();
  assert.equal(youtube.playbackState, 'paused'); assert.equal(youtube.currentPosition, 5);
  assert.equal(youtube.duration, null); // 0 = unknown, never a fake duration.
  youtube.player.events.onError({data: 101});
  assert.equal(youtube.playbackState, 'error');
});
