// Draft regression tests for the real main.js event wiring. Deliberately not
// executed as part of implementing this MVP. No real account/media/network.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// main.js runs in a VM realm, while the media doubles return host promises.
// Promise assimilation takes more than one microtask. Wait for the next event
// loop turn before asserting rejection side effects; never weaken expectations.
import {setImmediate as settlePlayback} from 'node:timers/promises';
import * as protocol from '../src/protocol.js';
import {PersonalHlsSource, personalHlsUrlProblem} from '../src/personal-hls.js';
import {PartySession as ActualPartySession} from '../src/session.js';

const privateUrl = 'https://media.example.test/private/master?token=INTEGRATION_PRIVATE_SENTINEL';
const vod = {live: false, totalduration: 120, fragments: [{start: 0, duration: 120}]};
const playback = {seq: 1, member_id: 'host', paused: true, position_ms: 5000, rate: 1, at: 1000, media_key: 'movie|tt1||'};

class Element {
  constructor() { this.value = ''; this.style = {}; this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; }
  addEventListener(event, callback) { this.listeners.set(event, [...(this.listeners.get(event) || []), callback]); }
  fire(event, details = {}) { for (const callback of this.listeners.get(event) || []) callback({preventDefault() {}, ...details}); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
}
class FakeHls {
  static Events = {LEVEL_LOADED: 'level', ERROR: 'error'};
  static isSupported() { return true; }
  constructor(config) { this.config = config; this.listeners = new Map(); }
  on(event, callback) { this.listeners.set(event, callback); }
  loadSource(value) { this.source = value; }
  attachMedia() {}
  destroy() { this.destroyed = true; this.source = null; }
  emit(event, data) { this.listeners.get(event)?.(event, data); }
}
async function harness({debug = false} = {}) {
  const elements = new Map(), storageWrites = [], sent = [];
  let clock = 0, tick = () => {};
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const player = get('player');
  get('resync').disabled = true; // Mirrors the initial HTML attribute.
  Object.assign(player, {paused: true, currentTime: 0, readyState: 0, duration: NaN, currentSrc: '', loadCount: 0,
    seekable: {length: 1, start: () => 0, end: () => 120},
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.fire('pause'); }, play() { this.paused = false; return Promise.resolve(); },
    removeAttribute() { this.currentSrc = ''; }, load() { this.loadCount++; },
    canPlayType() { return ''; },
  });
  let session;
  class FakeSession extends ActualPartySession {
    constructor(client, device, handlers) { super(client, device, handlers); session = this; }
    now() { return 1000; }
    sendPresence(...args) { sent.push(args); return Promise.resolve(); }
    requestState() { return Promise.resolve(); }
  }
  const client = {auth: {onAuthStateChange() {}, getSession: async () => ({data: {session: null}})}};
  const windowEvents = new Map();
  const context = vm.createContext({
    ...protocol, PersonalHlsSource, personalHlsUrlProblem, Hls: FakeHls, PartySession: FakeSession,
    createClient: () => client, callRpc: () => {throw Error('Unexpected RPC');},
    env: {VITE_SUPABASE_URL: 'https://backend.example.test', VITE_SUPABASE_ANON_KEY: 'sb_publishable_TEST'},
    document: {getElementById: get, createElement: () => new Element()}, location: {pathname: '/'},
    window: {addEventListener: (event, callback) => windowEvents.set(event, callback)},
    sessionStorage: {getItem: key => key === 'nuvio-party-debug' ? (debug ? '1' : null) : 'test-device', setItem: (...args) => storageWrites.push(args)},
    crypto: {randomUUID: () => 'test-id'}, performance: {now: () => clock},
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {}, setTimeout: () => 1,
  });
  const code = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('import.meta.env', 'env');
  vm.runInContext(code, context);
  await Promise.resolve();
  session.room = {info: {code: 'UXZ83H', media: {meta_type: 'movie', meta_id: 'tt1'}, host_member_id: 'host', host_only: true}, members: []};
  session.playback = playback; session.handlers.room(session.room);
  const source = () => vm.runInContext('personalHls', context);
  const enter = () => { get('personalHlsUrl').value = privateUrl; get('personalHlsForm').fire('submit'); };
  const metadata = () => { player.readyState = 1; player.duration = 120; player.currentSrc = 'blob:local-test'; player.fire('loadedmetadata'); };
  return {get, player, session, source, enter, metadata, sent, storageWrites, windowEvents,
    tick: () => tick(),
    advance: ms => { clock += ms; }, sync: () => vm.runInContext('syncEnabled', context),
    desktopHls: () => vm.runInContext('hls', context)};
}

test('manual source survives incompatible, compatible and revoked Desktop stream broadcasts', async () => {
  const h = await harness(); h.enter(); const instance = h.source().instance, loads = h.player.loadCount;
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv'});
  h.session.handlers.stream(null);
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/other.mp4'});
  assert.equal(h.source().instance, instance); assert.equal(h.player.loadCount, loads);
  assert.equal(h.get('personalHlsUrl').value, '');
  assert.ok(!JSON.stringify(h.sent).includes('INTEGRATION_PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(h.storageWrites).includes('INTEGRATION_PRIVATE_SENTINEL'));
});

test('a late fatal error from an old Desktop HLS instance cannot stop the personal source', async () => {
  const h = await harness();
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/old.m3u8'});
  h.get('loadStream').fire('click'); const old = h.desktopHls();
  h.enter(); const personal = h.source().instance, loads = h.player.loadCount;
  old.emit(FakeHls.Events.ERROR, {fatal: true, type: 'networkError'});
  assert.equal(h.source().instance, personal); assert.equal(h.player.loadCount, loads);
  assert.equal(personal.destroyed, undefined);
});

test('metadata alone cannot enable sync; VOD and seekability permit existing applySync to follow the host', async () => {
  const h = await harness(); h.enter(); h.metadata();
  assert.equal(h.get('resync').disabled, true);
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  assert.equal(h.get('resync').disabled, false);
  h.get('resync').fire('click');
  assert.equal(h.player.currentTime, 5); assert.equal(h.player.paused, true);
  h.player.fire('seeked');
  h.session.playback = {...playback, seq: 2, paused: false, position_ms: 20000};
  h.session.handlers.playback(); await settlePlayback();
  assert.equal(h.player.currentTime, 20); assert.equal(h.player.paused, false);
  h.player.fire('seeked');
  h.session.playback = {...playback, seq: 3, paused: true, position_ms: 30000};
  h.session.handlers.playback();
  assert.equal(h.player.currentTime, 30); assert.equal(h.player.paused, true);
});

test('real media changes, room closure and page exit clear private source and the URL input', async () => {
  for (const event of ['media', 'closed', 'pagehide']) {
    const h = await harness(); h.enter(); const instance = h.source().instance;
    h.get('personalHlsUrl').value = privateUrl;
    if (event === 'pagehide') h.windowEvents.get('pagehide')();
    else h.session.handlers[event]();
    assert.equal(h.source().active, false); assert.equal(h.source().instance, null);
    assert.equal(instance.destroyed, true); assert.equal(h.get('personalHlsUrl').value, '');
    assert.equal(h.get('resync').disabled, true);
  }
});

test('an authoritative room snapshot with a new media key also clears the personal source', async () => {
  const h = await harness(); h.enter();
  h.session.room.info.media = {meta_type: 'movie', meta_id: 'tt2'};
  h.session.handlers.room(h.session.room);
  assert.equal(h.source().active, false); assert.equal(h.source().instance, null);
  assert.equal(h.get('resync').disabled, true);
});

test('no room cannot load a source; live and expired sources never claim sync success', async () => {
  const outside = await harness(); outside.session.room = null; outside.enter();
  assert.equal(outside.source().active, false);
  for (const mode of ['live', 'expired']) {
    const h = await harness(); h.enter();
    if (mode === 'live') h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: {...vod, live: true}});
    else h.source().instance.emit(FakeHls.Events.ERROR, {fatal: true, response: {code: 403}, url: privateUrl});
    assert.equal(h.get('resync').disabled, true); assert.equal(h.player.paused, true);
    assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
    assert.match(h.get('message').textContent, mode === 'live' ? /Live/ : /abgelaufen/);
    h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mp4'});
    assert.equal(h.source().active, true); // Explicit source choice stays protected after failure.
  }
});

test('a rejected native seek stops synchronization without reflecting a token-bearing exception', async () => {
  const h = await harness(); h.enter(); h.metadata();
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  Object.defineProperty(h.player, 'currentTime', {get: () => 0, set: () => {throw Error(privateUrl);}});
  h.get('resync').fire('click');
  assert.equal(h.player.paused, true);
  assert.match(h.get('message').textContent, /nicht anspringen/);
  assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
});

async function readyGuest() {
  const h = await harness(); h.enter(); h.metadata();
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  return h;
}

test('AbortError retains synchronization through a host pause and retries the latest play state', async () => {
  const h = await readyGuest(); let rejectPlay, calls = 0;
  h.player.play = () => { calls++; h.player.paused = false; return new Promise((_resolve, reject) => { rejectPlay = reject; }); };
  h.session.playback = {...playback, paused: false}; h.get('resync').fire('click');
  h.session.handlers.playback(); assert.equal(calls, 1); // One pending play only.
  h.session.playback = {...playback, seq: 2}; h.session.handlers.playback();
  assert.equal(h.player.paused, true);
  rejectPlay({name: 'AbortError', message: privateUrl}); await settlePlayback();
  assert.equal(h.sync(), true);
  h.player.fire('seeked'); h.session.playback = {...playback, seq: 3, paused: false};
  h.player.play = () => { calls++; h.player.paused = false; return Promise.resolve(); };
  h.session.handlers.playback(); await settlePlayback();
  assert.equal(calls, 2); assert.equal(h.sync(), true);
  assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
});

test('NotAllowedError requires a user retry; NotSupportedError stops the unsupported source', async () => {
  for (const name of ['NotAllowedError', 'NotSupportedError', 'UnknownError']) {
    const h = await readyGuest(); h.session.playback = {...playback, paused: false};
    h.player.play = () => Promise.reject({name, message: privateUrl});
    h.get('resync').fire('click'); await settlePlayback();
    assert.equal(h.sync(), false);
    assert.equal(h.get('resync').disabled, name === 'NotSupportedError');
    assert.match(h.get('message').textContent, name === 'NotAllowedError' ? /blockiert/ : name === 'NotSupportedError' ? /Codecs/ : /fehlgeschlagen/);
    assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
    // An autoplay failure permits an explicit retry of the same loaded source;
    // an unsupported source has instead been removed and cannot restart.
    h.player.play = () => { h.player.paused = false; return Promise.resolve(); };
    if (name === 'NotAllowedError') {
      h.get('resync').fire('click'); await settlePlayback();
      assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
    } else if (name === 'NotSupportedError') {
      assert.equal(h.source().instance, null); assert.equal(h.player.paused, true);
      h.session.handlers.playback(); assert.equal(h.sync(), false);
    }
  }
});

test('AbortError from the current play attempt releases the pending start for the next host tick', async () => {
  const h = await readyGuest(); let calls = 0;
  h.session.playback = {...playback, paused: false};
  h.player.play = () => { calls++; return Promise.reject({name: 'AbortError', message: privateUrl}); };
  h.get('resync').fire('click'); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(calls, 1);
  h.player.play = () => { calls++; h.player.paused = false; return Promise.resolve(); };
  h.session.handlers.playback(); await settlePlayback();
  assert.equal(calls, 2); assert.equal(h.player.paused, false); assert.equal(h.sync(), true);
});

test('host pause then play can restart before the old AbortError has settled', async () => {
  const h = await readyGuest(); let rejectOld, calls = 0;
  h.session.playback = {...playback, paused: false};
  h.player.play = () => { calls++; h.player.paused = false; return new Promise((_resolve, reject) => {rejectOld = reject;}); };
  h.get('resync').fire('click');
  h.session.playback = {...playback, seq: 2}; h.session.handlers.playback();
  assert.equal(h.player.paused, true);
  h.player.play = () => { calls++; h.player.paused = false; return Promise.resolve(); };
  h.session.playback = {...playback, seq: 3, paused: false}; h.session.handlers.playback();
  assert.equal(calls, 2);
  rejectOld({name: 'AbortError', message: privateUrl}); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
});

test('obsolete play rejections and resolutions cannot damage an explicit newer start on the same source', async () => {
  for (const outcome of ['AbortError', 'NotAllowedError', 'NotSupportedError', 'resolve']) {
    const h = await readyGuest(), instance = h.source().instance;
    let rejectOld, resolveOld, resolveNew, calls = 0;
    h.session.playback = {...playback, paused: false};
    h.player.play = () => { calls++; h.player.paused = false; return new Promise((resolve, reject) => {resolveOld = resolve; rejectOld = reject;}); };
    h.get('resync').fire('click');
    h.player.play = () => { calls++; h.player.paused = false; return new Promise(resolve => {resolveNew = resolve;}); };
    h.get('resync').fire('click'); assert.equal(calls, 2);
    if (outcome === 'resolve') resolveOld();
    else rejectOld({name: outcome, message: privateUrl});
    await settlePlayback();
    assert.equal(h.sync(), true); assert.equal(h.source().instance, instance);
    assert.equal(instance.destroyed, undefined); assert.equal(h.get('resync').disabled, false);
    h.player.paused = true; h.session.handlers.playback();
    assert.equal(calls, 2); // The newer attempt is still pending, not cleared by the old callback.
    resolveNew(); await settlePlayback();
    h.player.play = () => { calls++; h.player.paused = false; return Promise.resolve(); };
    h.session.handlers.playback(); await settlePlayback();
    assert.equal(calls, 3); assert.equal(h.sync(), true);
    assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
  }
});

test('seek races and buffering coalesce host jumps and eventually follow the latest target', async () => {
  const h = await readyGuest(); let currentTime = 0, writes = 0;
  Object.defineProperty(h.player, 'currentTime', {get: () => currentTime, set: value => {currentTime = value; writes++; h.player.seeking = true;}});
  h.get('resync').fire('click'); h.player.fire('seeking'); assert.equal(h.sync(), true);
  h.session.playback = {...playback, seq: 2, position_ms: 30000};
  h.session.handlers.playback(); h.advance(10000); h.session.handlers.playback();
  assert.equal(writes, 1); // Even after timeout, native seeking is authoritative.
  h.player.fire('waiting'); h.player.seeking = false; h.player.fire('seeked');
  h.session.handlers.playback(); assert.equal(writes, 2); // Queued host seek ran immediately on seeked, despite buffering at the old target.
  h.player.fire('canplay'); h.session.handlers.playback();
  assert.equal(writes, 2); assert.equal(currentTime, 30); assert.equal(h.sync(), true);
  h.player.seeking = false; h.player.fire('seeked');
  h.session.playback = {...playback, seq: 3, position_ms: 45000}; h.session.handlers.playback();
  h.player.seeking = false; // Lost seeked: a bounded fallback still resumes.
  h.advance(6000); h.session.playback = {...playback, seq: 4, position_ms: 60000}; h.session.handlers.playback();
  assert.equal(currentTime, 60);
});

test('hls.js gap/nudge recovery stays synchronized, but a manual seek even inside the suppression window does not', async () => {
  for (const details of ['bufferSeekOverHole', 'bufferNudgeOnStall']) {
    const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
    h.player.currentTime = 5.2;
    h.source().instance.emit(FakeHls.Events.ERROR, {fatal: false, type: 'mediaError', details, reason: privateUrl});
    h.player.fire('seeking'); assert.equal(h.sync(), true);
    h.player.fire('seeked'); h.player.fire('pointerdown'); h.player.currentTime = 55; h.player.fire('seeking');
    assert.equal(h.sync(), false);
    assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
  }
});

test('empty media keys and open return/throw failures cannot leave a phantom loading source', async () => {
  for (const media of [null, {}, {meta_type: 'movie'}]) {
    const h = await harness(); h.session.room.info.media = media; h.enter();
    assert.equal(h.source().active, false); assert.equal(h.get('resync').disabled, true);
    assert.match(h.get('message').textContent, /Filmkennung/);
  }
  for (const throws of [false, true]) {
    const h = await harness(); h.source().open = () => {if (throws) throw Error(privateUrl); return 'Quelle konnte nicht geöffnet werden.';};
    h.enter(); assert.equal(h.get('resync').disabled, true);
    assert.equal(h.player.paused, true); assert.equal(h.sent.at(-1)[0], 'browsing');
    assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
  }
});

test('a temporary missing seek range waits without losing synchronization or claiming ready presence', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  h.player.seekable = {length: 0}; h.session.handlers.playback();
  h.advance(1000); h.tick(); // Only sustained starvation may pause the party.
  assert.equal(h.sync(), true); assert.equal(h.sent.at(-1)[0], 'buffering');
  h.player.seekable = {length: 1, start: () => 0, end: () => 120};
  h.session.handlers.playback(); h.player.fire('canplay');
  assert.equal(h.sync(), true); assert.equal(h.sent.at(-1)[0], 'ready');
});

test('host change preserves a personal source for the same movie; party end destroys it and ignores late play rejection', async () => {
  const h = await readyGuest(), instance = h.source().instance;
  h.session.room.info.host_member_id = 'new-host'; h.session.handlers.stream(null); h.session.handlers.room(h.session.room);
  assert.equal(h.source().instance, instance);
  let rejectPlay; h.player.play = () => new Promise((_resolve, reject) => {rejectPlay = reject;});
  h.session.playback = {...playback, member_id: 'new-host', paused: false}; h.get('resync').fire('click');
  h.session.handlers.ended('Die Party wurde beendet.');
  rejectPlay({name: 'NotAllowedError', message: privateUrl}); await settlePlayback();
  assert.equal(h.source().active, false); assert.equal(instance.destroyed, true);
  assert.equal(h.sync(), false); assert.equal(h.get('resync').disabled, true);
  assert.equal(h.get('message').textContent, 'Die Party wurde beendet.');
});

test('real receive/acceptPlayback wiring follows realtime play and pause immediately and ignores a stale snapshot', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  h.session.receive('state', {...playback, seq: 2, paused: false});
  assert.equal(h.player.paused, false); assert.equal(h.session.diagnostics.acceptedSource, 'realtime');
  await settlePlayback();
  h.session.acceptPlayback({...playback, seq: 1, paused: true}, 'snapshot'); h.tick();
  assert.equal(h.player.paused, false); assert.equal(h.sync(), true);
  h.player.fire('waiting'); h.player.seekable = {length: 0};
  h.session.receive('state', {...playback, seq: 3, paused: true});
  assert.equal(h.player.paused, true); // No canplay, metadata or timer wait.
  assert.equal(h.sync(), true);
});

test('brief buffering and pending starts do not stall the party; sustained starvation does', async () => {
  const h = await readyGuest(); h.session.playback = {...playback, paused: false};
  let finishPlay; h.player.play = () => { h.player.paused = false; return new Promise(resolve => {finishPlay = resolve;}); };
  h.get('resync').fire('click'); assert.equal(h.sent.at(-1)[0], 'ready');
  h.player.fire('waiting'); h.advance(999); h.tick(); assert.equal(h.sent.at(-1)[0], 'ready');
  h.advance(1); h.tick(); assert.equal(h.sent.at(-1)[0], 'buffering');
  h.player.fire('canplay'); assert.equal(h.sent.at(-1)[0], 'ready');
  finishPlay(); await settlePlayback(); assert.equal(h.sync(), true);
});

test('a new host seek can escape buffering without repeating seeks for every clock tick', async () => {
  const h = await readyGuest(); let current = 0, writes = 0, hostTime = 1000;
  h.session.now = () => hostTime;
  Object.defineProperty(h.player, 'currentTime', {get: () => current, set: value => {current = value; writes++;}});
  h.session.playback = {...playback, paused: false}; h.get('resync').fire('click');
  await settlePlayback(); h.player.fire('seeked'); h.player.fire('waiting');
  hostTime += 10000; h.tick(); h.tick(); assert.equal(writes, 1);
  h.session.receive('state', {...playback, seq: 2, position_ms: 45000, paused: false, at: hostTime});
  assert.equal(current, 45); assert.equal(writes, 2);
  hostTime += 10000; h.tick(); assert.equal(writes, 2);
  h.player.fire('canplay'); assert.equal(current, 55); assert.equal(writes, 3);
});

test('unreported internal HLS seeking and delayed native pause events do not disable sync; native gestures do', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  h.player.currentTime = 5.2; h.player.fire('seeking'); h.player.fire('seeked');
  assert.equal(h.sync(), true);
  h.session.receive('state', {...playback, seq: 2, paused: false}); await settlePlayback();
  // Queue the browser pause event until after the former one-second timer.
  h.player.pause = () => {h.player.paused = true;};
  h.session.receive('state', {...playback, seq: 3, paused: true});
  h.advance(2000); h.player.fire('pause'); assert.equal(h.sync(), true);
  h.player.fire('keydown', {key: 'ArrowRight'}); h.player.currentTime = 55; h.player.fire('seeking');
  assert.equal(h.sync(), false);
});

test('local diagnostics are opt-in, show only allowlisted fields and never reflect raw error or state payloads', async () => {
  const off = await harness(); off.tick(); assert.equal(off.get('watchSection').children.length, 0);
  const h = await harness({debug: true}); h.enter(); h.metadata();
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  h.session.diagnostics.url = privateUrl; h.session.diagnostics.error = privateUrl;
  h.session.receive('state', {...playback, seq: 2, paused: false, token: privateUrl});
  h.player.play = () => Promise.reject({name: 'NotAllowedError', message: privateUrl});
  h.get('resync').fire('click'); await settlePlayback(); h.tick();
  const text = h.get('watchSection').children.at(-1).children.at(-1).textContent;
  const data = JSON.parse(text);
  assert.equal(data.acceptedSource, 'realtime'); assert.equal(data.playbackSeq, 2);
  assert.equal(data.lastPlaybackError, 'NotAllowedError'); assert.equal(data.syncActive, false);
  assert.equal(data.realtimeStateCount, 1); assert.equal(typeof data.lastRealtimeStateAt, 'number');
  assert.ok(!text.includes('INTEGRATION_PRIVATE_SENTINEL')); assert.ok(!text.includes('https://'));
});

test('the existing stream broadcast loads extensionless HLS, applies safe headers and revokes the player on null', async () => {
  const h = await harness();
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/session', stream_type: 'hls', headers: {Accept: 'application/vnd.apple.mpegurl'}});
  h.get('loadStream').fire('click'); const instance = h.desktopHls();
  assert.equal(instance.source, 'https://stream.example.test/session');
  const headers = [], xhr = {setRequestHeader: (...args) => headers.push(args)};
  instance.config.xhrSetup(xhr);
  assert.equal(xhr.withCredentials, false); assert.equal(headers[0][0], 'Accept');
  h.metadata(); h.get('resync').fire('click');
  h.session.receive('state', {...playback, seq: 2, paused: false}); await settlePlayback();
  assert.equal(h.player.paused, false);
  h.player.fire('seeked'); h.player.currentTime += .1;
  instance.emit(FakeHls.Events.ERROR, {fatal: false, details: 'bufferSeekOverHole'});
  h.player.fire('seeking'); h.player.fire('seeked');
  assert.equal(h.sync(), true);
  h.session.handlers.stream(null);
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true);
  assert.equal(h.get('resync').disabled, true);
  h.session.receive('state', {...playback, seq: 3, paused: false});
  assert.equal(h.player.paused, true); // A revoked source cannot resume from later state messages.
});

test('browser HLS metadata selects only the browser transport while keeping the one accepted party playback state', async () => {
  const h = await harness();
  const original = {media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv',
    filename: 'original.mkv', headers: {Referer: 'https://desktop.example.test'}, video_size: 4000000,
    browser_hls: {url: 'https://stream.example.test/browser.m3u8', media_key: 'untrusted-nested-key'}};
  const before = JSON.stringify(original);
  h.session.handlers.stream(original); h.get('loadStream').fire('click');
  const instance = h.desktopHls();
  assert.equal(instance.source, original.browser_hls.url);
  h.metadata(); h.get('resync').fire('click');
  const state = {...playback, seq: 2, paused: false};
  h.session.receive('state', state); await settlePlayback();
  assert.equal(h.session.playback, state); assert.equal(h.player.paused, false);
  h.session.handlers.stream({...original, browser_hls: {url: null}});
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true);
  assert.equal(h.desktopHls(), null); assert.equal(h.get('resync').disabled, true);
  assert.match(h.get('streamInfo').textContent, /Browser-HLS/);
  assert.equal(h.session.playback, state); assert.equal(JSON.stringify(original), before);
  h.session.handlers.stream({...original, browser_hls: {url: 'https://stream.example.test/renewed.m3u8'}});
  h.get('loadStream').fire('click');
  assert.equal(h.desktopHls().source, 'https://stream.example.test/renewed.m3u8');
  assert.equal(h.session.playback, state);
  h.session.handlers.stream(null); assert.equal(h.player.paused, true);
});
