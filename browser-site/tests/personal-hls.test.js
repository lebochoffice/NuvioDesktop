import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {PersonalHlsSource, personalHlsUrlProblem, inspectHlsPlaylist, vodSyncTarget, personalHlsErrorMessage} from '../src/personal-hls.js';

const privateUrl = 'https://media.example.test/personal/master?token=PRIVATE_TEST_SENTINEL';
const vod = () => ({live: false, totalduration: 120, fragments: [{start: 0, duration: 120}]});
const video = () => ({readyState: 1, duration: 120, seekable: {length: 1, start: () => 0, end: () => 120}});

export class FakeHls {
  static Events = {LEVEL_LOADED: 'level', ERROR: 'error'};
  static isSupported() { return true; }
  constructor(config) { this.config = config; this.handlers = new Map(); this.destroyed = false; }
  on(event, callback) { this.handlers.set(event, callback); }
  loadSource(url) { this.source = url; }
  attachMedia(player) { this.player = player; }
  destroy() { this.destroyed = true; this.source = null; }
  emit(event, data) { this.handlers.get(event)?.(event, data); }
}

test('personal playlist URL accepts opaque HTTPS paths and rejects unsafe input without reflecting it', () => {
  assert.equal(personalHlsUrlProblem(privateUrl), '');
  for (const value of ['', 'http://media.example.test/a.m3u8', 'https://user:password@media.example.test/a', 'https://127.1/a', 'https://media.example.test/a#PRIVATE_TEST_SENTINEL', 'https://media.example.test/a\n?token=PRIVATE_TEST_SENTINEL']) {
    const problem = personalHlsUrlProblem(value);
    assert.ok(problem); assert.ok(!problem.includes('PRIVATE_TEST_SENTINEL')); assert.ok(!problem.includes('password'));
  }
});

test('VOD requires final media details; a master/unknown/live/invalid playlist is not enough', () => {
  assert.equal(inspectHlsPlaylist(vod()).kind, 'vod');
  assert.equal(inspectHlsPlaylist({...vod(), live: true}).kind, 'live');
  for (const details of [undefined, {levels: [{}]}, {...vod(), live: undefined}, {...vod(), totalduration: Infinity}, {...vod(), fragments: []}, {...vod(), iframesOnly: true}, {...vod(), playlistParsingError: Error('PRIVATE_TEST_SENTINEL')}]) {
    const result = inspectHlsPlaylist(details);
    assert.equal(result.kind, 'invalid'); assert.ok(!result.message.includes('PRIVATE_TEST_SENTINEL'));
  }
});

test('seek readiness requires finite metadata and the actual requested time inside a seekable range', () => {
  const playlist = inspectHlsPlaylist(vod());
  assert.deepEqual(vodSyncTarget(playlist, video(), 45), {ready: true, seconds: 45});
  assert.equal(vodSyncTarget(playlist, video(), 125).ready, false); // Never silently clamp the wrong film to its end.
  assert.equal(vodSyncTarget(playlist, {...video(), duration: Infinity}, 5).ready, false);
  assert.equal(vodSyncTarget(playlist, {...video(), readyState: 0}, 5).ready, false);
  assert.equal(vodSyncTarget(playlist, {...video(), seekable: {length: 0}}, 5).ready, false);
  const gapped = {...video(), seekable: {length: 2, start: i => i ? 40 : 0, end: i => i ? 90 : 10}};
  assert.equal(vodSyncTarget(playlist, gapped, 20).ready, false);
  assert.equal(vodSyncTarget(playlist, gapped, 50).ready, true);
  assert.equal(vodSyncTarget(inspectHlsPlaylist({...vod(), live: true}), video(), 5).ready, false);
});

test('errors are fixed messages; URL, token, stack and raw provider text are never included', () => {
  const raw = {url: privateUrl, reason: privateUrl, error: Error(privateUrl)};
  assert.match(personalHlsErrorMessage({...raw, response: {code: 403}}), /abgelaufen/);
  assert.match(personalHlsErrorMessage({...raw, response: {code: 410}}), /nicht mehr verfügbar/);
  assert.match(personalHlsErrorMessage({...raw, type: 'mediaError'}), /Codec/);
  for (const error of [raw, {...raw, details: 'manifestParsingError'}, {...raw, type: 'networkError', networkDetails: {status: 0}}]) {
    const message = personalHlsErrorMessage(error);
    assert.ok(!message.includes('PRIVATE_TEST_SENTINEL')); assert.ok(!message.includes('https://'));
  }
});

test('hls.js receives the original base URL for relative segments, with no custom headers/cookies/debug logs', () => {
  const source = new PersonalHlsSource(FakeHls, video());
  assert.equal(source.open(privateUrl, 'movie|tt1||'), '');
  assert.equal(source.instance.source, privateUrl);
  assert.equal(new URL('segments/000.ts', source.instance.source).href, 'https://media.example.test/personal/segments/000.ts');
  assert.equal(source.instance.config.debug, false);
  const xhr = {};
  source.instance.config.xhrSetup(xhr, 'https://media.example.test/personal/segments/000.ts');
  assert.equal(xhr.withCredentials, false);
  assert.throws(() => source.instance.config.xhrSetup(xhr, 'http://media.example.test/a.ts'), /HTTPS/);
  source.clear();
});

test('live playlists and fatal errors stop loading but keep the manual selection protected', () => {
  const errors = [], source = new PersonalHlsSource(FakeHls, video(), {onError: message => errors.push(message)});
  source.open(privateUrl, 'movie|tt1||'); const instance = source.instance;
  instance.emit(FakeHls.Events.LEVEL_LOADED, {details: {...vod(), live: true}});
  assert.ok(instance.destroyed); assert.equal(source.instance, null); assert.equal(source.active, true);
  assert.match(errors[0], /Live/);
  source.open(privateUrl, 'movie|tt1||');
  source.instance.emit(FakeHls.Events.ERROR, {fatal: false, type: 'networkError', response: {code: 403}, url: privateUrl});
  assert.equal(source.instance, null); assert.equal(source.active, true);
  assert.ok(errors.every(message => !message.includes('PRIVATE_TEST_SENTINEL')));
  source.clear(); assert.equal(source.active, false); assert.equal(source.mediaKey, null);
});

test('callbacks from a destroyed HLS instance cannot alter a replacement source', () => {
  const playlists = [], errors = [], source = new PersonalHlsSource(FakeHls, video(), {onPlaylist: p => playlists.push(p), onError: e => errors.push(e)});
  source.open(privateUrl, 'movie|tt1||'); const old = source.instance;
  source.open('https://media.example.test/replacement.m3u8', 'movie|tt2||'); const current = source.instance;
  old.emit(FakeHls.Events.ERROR, {fatal: true, type: 'mediaError'});
  old.emit(FakeHls.Events.LEVEL_LOADED, {details: vod()});
  assert.equal(source.instance, current); assert.equal(source.mediaKey, 'movie|tt2||');
  assert.deepEqual(errors, []); assert.deepEqual(playlists, []);
  current.emit(FakeHls.Events.LEVEL_LOADED, {details: vod()});
  assert.equal(playlists[0].kind, 'vod');
  source.clear();
});

test('an empty media key returns a fixed failure before creating any HLS instance', () => {
  const source = new PersonalHlsSource(FakeHls, video());
  for (const key of [null, undefined, '', '   ']) {
    assert.match(source.open(privateUrl, key), /Filmkennung/);
    assert.equal(source.active, false); assert.equal(source.instance, null);
  }
});

test('support detection exceptions and constructor exceptions use the safe error callback', () => {
  for (const Hls of [class extends FakeHls { static isSupported() {throw Error(privateUrl);} },
    class extends FakeHls { constructor() {super(); throw Error(privateUrl);} }]) {
    const errors = [], source = new PersonalHlsSource(Hls, video(), {onError: error => errors.push(error)});
    assert.equal(source.open(privateUrl, 'movie|tt1||'), '');
    assert.equal(errors.length, 1); assert.equal(source.instance, null);
    assert.ok(!errors[0].includes('PRIVATE_TEST_SENTINEL'));
  }
});

test('recoverable gap signals expose only a numeric target and ignore stale instances', () => {
  const targets = [], player = {...video(), currentTime: 5.1};
  const source = new PersonalHlsSource(FakeHls, player, {onInternalSeek: seconds => targets.push(seconds)});
  source.open(privateUrl, 'movie|tt1||'); const old = source.instance;
  old.emit(FakeHls.Events.ERROR, {fatal: false, details: 'bufferSeekOverHole', reason: privateUrl});
  assert.deepEqual(targets, [5.1]);
  source.clear(); old.emit(FakeHls.Events.ERROR, {fatal: false, details: 'bufferNudgeOnStall'});
  assert.deepEqual(targets, [5.1]);
});
