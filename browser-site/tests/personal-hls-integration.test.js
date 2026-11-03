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
import * as syncPolicy from '../src/sync-policy.js';

const privateUrl = 'https://media.example.test/private/master?token=INTEGRATION_PRIVATE_SENTINEL';
const vod = {live: false, totalduration: 120, fragments: [{start: 0, duration: 120}]};
const playback = {seq: 1, member_id: 'host', paused: true, position_ms: 5000, rate: 1, at: 1000, media_key: 'movie|tt1||'};

class Element {
  constructor() { this.value = ''; this.style = {}; this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; }
  addEventListener(event, callback) { this.listeners.set(event, [...(this.listeners.get(event) || []), callback]); }
  fire(event, details = {}) { for (const callback of this.listeners.get(event) || []) callback({preventDefault() {}, ...details}); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...children) { this.children = children; }
}
class FakeHls {
  static Events = {LEVEL_LOADED: 'level', ERROR: 'error', MANIFEST_PARSED: 'manifest', FRAG_LOADED: 'frag', LEVEL_SWITCHED: 'switched', SUBTITLE_TRACKS_UPDATED: 'subtitles'};
  static isSupported() { return true; }
  constructor(config) { this.config = config; this.listeners = new Map(); }
  on(event, callback) { this.listeners.set(event, callback); }
  loadSource(value) { this.source = value; }
  attachMedia() {}
  destroy() { this.destroyed = true; this.source = null; }
  emit(event, data) { this.listeners.get(event)?.(event, data); }
}
async function harness({debug = false, guestControl = false, guestJoin = false, rpc = null, path = '/'} = {}) {
  const elements = new Map(), storageWrites = [], sent = [];
  let clock = 0, tick = () => {};
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const player = get('player');
  get('resync').disabled = true; // Mirrors the initial HTML attribute.
  get('subtitleMenu').hidden = true; get('infoDrawer').hidden = true; // Initially hidden in the HTML.
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
  const anonymousSignIns = [], logins = [];
  let authSession = rpc?.session ?? null;
  const client = {auth: {onAuthStateChange() {}, getSession: async () => ({data: {session: authSession}}),
    signInWithPassword: async ({email, password}) => {
      logins.push({email, hasPassword: !!password});
      if (rpc?.loginError) return {data: {user: null, session: null}, error: {message: 'Invalid login credentials'}};
      authSession = {access_token: 'test', user: {id: 'u1', is_anonymous: false, email, user_metadata: rpc?.metadata || {}}};
      return {data: {user: authSession.user, session: authSession}, error: null};
    },
    signOut: async () => { authSession = null; },
    signInAnonymously: async () => { anonymousSignIns.push(1); return {data: {}}; }}};
  const windowEvents = new Map();
  const context = vm.createContext({
    ...protocol, ...syncPolicy, PersonalHlsSource, personalHlsUrlProblem, Hls: FakeHls, PartySession: FakeSession,
    createClient: () => client, callRpc: (_client, name, args) => { if (rpc?.[name]) return rpc[name](args); throw Error('Unexpected RPC'); }, URL, Blob,
    env: {VITE_SUPABASE_URL: 'https://backend.example.test', VITE_SUPABASE_ANON_KEY: 'sb_publishable_TEST', ...(guestControl === true ? {VITE_PARTY_GUEST_CONTROL: '1'} : typeof guestControl === 'string' ? {VITE_PARTY_GUEST_CONTROL: guestControl} : {}), ...(guestJoin ? {VITE_PARTY_GUEST_JOIN: '1'} : {})},
    document: {getElementById: get, createElement: () => new Element()}, location: {pathname: path, origin: 'https://watch.example.test'},
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
  return {get, player, session, source, enter, metadata, sent, storageWrites, windowEvents, anonymousSignIns, logins,
    tick: () => tick(),
    advance: ms => { clock += ms; }, sync: () => vm.runInContext('syncEnabled', context),
    desktopHls: () => vm.runInContext('hls', context), run: code => vm.runInContext(code, context)};
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

async function readyGuest(options) {
  const h = await harness(options); h.enter(); h.metadata();
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
  h.advance(2500); h.tick(); // Only sustained starvation may pause the party.
  assert.equal(h.sync(), true); assert.equal(h.sent.at(-1)[0], 'buffering');
  h.player.seekable = {length: 1, start: () => 0, end: () => 120};
  h.session.handlers.playback(); h.player.fire('canplay');
  assert.equal(h.sent.at(-1)[0], 'buffering'); // Hysteresis: stable playback first.
  h.advance(750); h.tick();
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
  // WLAN/mobile: a 2.4 s stall stays local; the party is not paused.
  h.player.fire('waiting'); h.advance(2499); h.tick(); assert.equal(h.sent.at(-1)[0], 'ready');
  h.advance(1); h.tick(); assert.equal(h.sent.at(-1)[0], 'buffering');
  h.player.fire('canplay'); assert.equal(h.sent.at(-1)[0], 'buffering');
  h.advance(750); h.tick(); assert.equal(h.sent.at(-1)[0], 'ready');
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

// --- Mobile synchronisation and guest control (feature/party-mobile-sync-control) ---

// Simulates the existing Nuvio RPC: confirm stores exactly the sent playback.
function controllable(h, {confirm = true, hostOnlyAfter = false, hold = false} = {}) {
  const rpcs = [], sends = [], pending = [];
  h.session.room.memberId = 'guest';
  h.session.room.info.host_only = false;
  h.session.channel = {send: async message => { sends.push(message); return 'ok'; }};
  h.session.client.removeChannel = async () => {};
  h.session.rpc = (name, args) => {
    rpcs.push([name, args]);
    const reply = () => ({party: {...h.session.room?.info, host_only: hostOnlyAfter,
      playback: confirm ? {...args.p_playback} : {...playback}}});
    if (!hold) return Promise.resolve(reply());
    return new Promise(resolve => pending.push(() => resolve(reply())));
  };
  return {rpcs, sends, release: () => pending.shift()?.()};
}
async function playingGuest(options) {
  const h = await readyGuest(options); h.session.playback = {...playback, paused: false};
  h.get('resync').fire('click'); await settlePlayback(); h.player.fire('seeked');
  return h;
}

test('mobile network: repeated sustained stalls use a wait budget, then the guest catches up alone', async () => {
  const h = await playingGuest();
  const stall = () => { h.player.fire('waiting'); h.advance(2500); h.tick(); const state = h.sent.at(-1)[0];
    h.player.fire('canplay'); h.advance(750); h.tick(); assert.equal(h.sent.at(-1)[0], 'ready'); return state; };
  assert.equal(stall(), 'buffering'); assert.equal(stall(), 'buffering');
  assert.equal(stall(), 'behind'); // The Desktop coordinator does not pause everyone for "behind".
  assert.equal(h.sync(), true);
  h.advance(120000); assert.equal(stall(), 'buffering');
});

test('stall recovery: no re-seek while segments load, then one catch-up seek ahead by the measured delay', async () => {
  const h = await readyGuest(); let current = 0, writes = 0, hostTime = 1000;
  h.session.now = () => hostTime;
  Object.defineProperty(h.player, 'currentTime', {get: () => current, set: value => {current = value; writes++;}});
  h.session.playback = {...playback, paused: false}; h.get('resync').fire('click'); await settlePlayback();
  assert.equal(writes, 1); assert.equal(current, 5);
  h.player.fire('waiting'); h.advance(2000); hostTime += 2000; h.tick(); h.tick();
  assert.equal(writes, 1); // Seek chase prevented while the target segment loads.
  h.player.fire('playing'); // Recovered after 2 s: lead learned, land ahead.
  assert.equal(writes, 2); assert.equal(current, 9);
  h.player.buffered = {length: 1, start: () => 0, end: () => 60};
  h.session.receive('state', {...playback, seq: 2, paused: false, position_ms: 30000, at: hostTime});
  assert.equal(writes, 3); assert.equal(current, 30); // Buffered target: exact, no lead.
});

test('playback-rate nudging uses hysteresis instead of flapping every tick', async () => {
  const h = await playingGuest();
  h.player.currentTime = 4.7; h.tick(); assert.equal(h.player.playbackRate, 1.05);
  h.player.currentTime = 4.85; h.tick(); assert.equal(h.player.playbackRate, 1.05);
  h.player.currentTime = 4.95; h.tick(); assert.equal(h.player.playbackRate, 1);
  h.player.currentTime = 4.85; h.tick(); assert.equal(h.player.playbackRate, 1);
  h.player.fire('waiting'); h.player.currentTime = 4.7; h.tick(); assert.equal(h.player.playbackRate, 1); // Never while stalled.
});

test('hostOnly=false: browser pause, seek and play become server-confirmed party commands without echo loops', async () => {
  const h = await playingGuest({guestControl: true}), c = controllable(h);
  h.session.handlers.room(h.session.room);
  assert.match(h.get('controlInfo').textContent, /Play, Pause und Springen.*für alle.*vom Host erlaubt/);
  h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause'); await settlePlayback();
  assert.equal(h.sync(), true);
  assert.equal(c.rpcs[0][0], 'watch_party_update');
  const first = c.rpcs[0][1].p_playback;
  assert.deepEqual([first.seq, first.member_id, first.paused, first.media_key], [2, 'guest', true, 'movie|tt1||']);
  assert.equal(c.sends[0].event, 'state'); assert.equal(c.sends[0].payload.seq, 2);
  assert.equal(h.session.playback.seq, 2); assert.equal(h.session.diagnostics.lastCommandResult, 'confirmed');
  h.player.currentTime = 40; h.player.fire('seeking'); h.player.fire('seeked'); await settlePlayback();
  assert.deepEqual([c.rpcs[1][1].p_playback.position_ms, c.rpcs[1][1].p_playback.paused], [40000, true]);
  h.player.paused = false; h.player.fire('play'); await settlePlayback();
  assert.deepEqual([c.rpcs[2][1].p_playback.seq, c.rpcs[2][1].p_playback.paused, c.rpcs[2][1].p_playback.position_ms], [4, false, 40000]);
  h.tick(); h.tick(); await settlePlayback();
  assert.equal(c.rpcs.length, 3); assert.equal(c.sends.length, 3); // Applying confirmed states sends nothing.
});

test('hostOnly=true: browser gestures never send commands and only leave local sync', async () => {
  const h = await playingGuest({guestControl: true}), c = controllable(h); h.session.room.info.host_only = true;
  assert.equal(h.session.canControl(), false);
  assert.throws(() => h.session.prepareControl({paused: true, positionMs: 0}), e => e.code === 'host_only');
  h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause'); await settlePlayback();
  assert.equal(h.sync(), false); assert.equal(c.rpcs.length, 0); assert.equal(c.sends.length, 0);
});

test('unconfirmed or host-revoked commands are never broadcast and the party state is restored', async () => {
  for (const options of [{confirm: false}, {hostOnlyAfter: true}]) {
    const h = await playingGuest({guestControl: true}), c = controllable(h, options);
    h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause'); await settlePlayback();
    assert.equal(c.rpcs.length, 1); assert.equal(c.sends.length, 0);
    assert.equal(h.session.playback.seq, 1); assert.equal(h.player.paused, false); // Party keeps playing.
    assert.match(h.get('message').textContent, options.confirm === false ? /nicht bestätigt/ : /deaktiviert/);
    if (options.hostOnlyAfter) assert.equal(h.session.canControl(), false);
  }
});

test('concurrent commands resolve deterministically by sequence and member id; stale snapshots cannot override', async () => {
  const h = await playingGuest({guestControl: true}), c = controllable(h, {hold: true});
  h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause');
  // While our seq 2 is in flight, another guest's seq 2 arrives; 'zz-guest' > 'guest' wins everywhere.
  const other = {...playback, seq: 2, member_id: 'zz-guest', paused: false, position_ms: 60000};
  h.session.receive('state', other);
  assert.equal(h.player.currentTime, 60); assert.equal(h.player.paused, false);
  c.release(); await settlePlayback();
  assert.equal(h.session.playback, other); assert.equal(c.sends.length, 1); // Ours is still distributed; receivers apply the same tie-break.
  h.session.acceptPlayback({...playback, seq: 1, paused: true}, 'snapshot');
  assert.equal(h.session.playback, other); assert.equal(h.player.paused, false);
});

test('gestures during an in-flight command are coalesced to the latest one', async () => {
  const h = await playingGuest({guestControl: true}), c = controllable(h, {hold: true});
  h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause');
  for (const time of [20, 30, 50]) { h.player.currentTime = time; h.player.fire('seeking'); h.player.fire('seeked'); }
  assert.equal(c.rpcs.length, 1);
  c.release(); await settlePlayback();
  assert.equal(c.rpcs.length, 2); assert.equal(c.rpcs[1][1].p_playback.position_ms, 50000);
  c.release(); await settlePlayback(); assert.equal(c.sends.length, 2);
});

test('session end or member removal during a pending command never broadcasts it', async () => {
  const h = await playingGuest({guestControl: true}), c = controllable(h, {hold: true});
  h.player.fire('pointerdown'); h.player.paused = true; h.player.fire('pause');
  await h.session.close(false);
  c.release(); await settlePlayback();
  assert.equal(c.sends.length, 0); assert.equal(h.session.diagnostics.lastCommandResult, 'closed');
  assert.equal(h.sync(), false); assert.match(h.get('controlInfo').textContent, /nur der Host/);
});

test('iOS-style native HLS skips hls.js and quality UI; Android-style hls.js gets tuning and real variants only', async () => {
  const ios = await harness({debug: true}); ios.player.canPlayType = () => 'maybe';
  ios.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/ios.m3u8'});
  ios.get('loadStream').fire('click');
  assert.equal(ios.desktopHls(), null); assert.equal(ios.player.src, 'https://stream.example.test/ios.m3u8');
  assert.equal(ios.get('qualityWrap').hidden, true);
  assert.match(ios.get('qualityNote').textContent, /vom Browser gewählt/); assert.equal(ios.get('qualityNote').hidden, false);
  ios.tick(); assert.equal(JSON.parse(ios.get('watchSection').children.at(-1).children.at(-1).textContent).playbackMode, 'native-hls');

  const android = await harness();
  android.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/android.m3u8'});
  android.get('loadStream').fire('click');
  const instance = android.desktopHls();
  assert.equal(instance.config.backBufferLength, 30); assert.equal(instance.config.startFragPrefetch, true); assert.equal(instance.config.debug, false);
  instance.levels = [{height: 1080, bitrate: 6e6}]; instance.emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(android.get('qualityWrap').hidden, true); // Single-variant playlists: no invented choices.
  assert.match(android.get('qualityNote').textContent, /Automatisch · eine Qualität verfügbar/);
  instance.levels = [{height: 720, bitrate: 3e6}, {height: 1080, bitrate: 6e6}, {height: 2160, bitrate: 15e6}];
  instance.emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(android.get('qualityWrap').hidden, false); assert.equal(android.get('qualityNote').hidden, true);
  assert.deepEqual(android.get('quality').children.map(o => o.textContent), ['Auto', '4K', '1080p', '720p']);
  android.get('quality').value = '1'; android.get('quality').fire('change'); assert.equal(instance.nextLevel, 1);
  instance.emit(FakeHls.Events.LEVEL_SWITCHED, {level: 1});
  assert.equal(android.get('qualityNote').textContent, 'Aktiv: 1080p'); // The actually playing variant is visible.
  assert.equal(android.get('qualityNote').hidden, false);
  android.get('quality').value = '7'; android.get('quality').fire('change'); assert.equal(instance.nextLevel, 1); // Unknown level ignored.
  android.get('quality').value = '-1'; android.get('quality').fire('change'); assert.equal(instance.nextLevel, -1);
});

test('TorBox single-variant HLS shows a fixed automatic-quality note instead of a selector', async () => {
  const h = await harness();
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: 'https://stream.example.test/torbox.m3u8'}});
  h.get('loadStream').fire('click'); const instance = h.desktopHls();
  instance.levels = [{height: 1080, bitrate: 6e6}, {height: 1080, bitrate: 5e6}]; instance.emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(h.get('qualityWrap').hidden, true);
  assert.equal(h.get('qualityNote').textContent, 'Automatisch · TorBox liefert eine Qualität');
  h.session.handlers.stream(null);
  assert.equal(h.get('qualityNote').hidden, true); // Cleared with the source.
});

test('VITE_PARTY_GUEST_CONTROL=off: shared browser control is disabled even with host_only=false; Desktop control unaffected', async () => {
  const h = await playingGuest({debug: true, guestControl: 'off'}), c = controllable(h);
  h.session.handlers.room(h.session.room); h.tick();
  assert.match(h.get('controlInfo').textContent, /ausgeschaltet/);
  assert.equal(h.get('syncChip').textContent, 'Synchron');
  h.get('ctlPlay').fire('click'); await settlePlayback(); // Player's own pause button.
  assert.equal(c.rpcs.length, 0); assert.equal(c.sends.length, 0); assert.equal(h.sync(), false); // Local only, as in PR #2.
  assert.equal(h.get('syncChip').textContent, 'Nicht synchron');
  const data = JSON.parse(h.get('watchSection').children.at(-1).children.at(-1).textContent);
  assert.equal(data.guestControl, false); assert.equal(data.controlBlockedReason, 'disabled_in_build');
  // Host commands still apply.
  h.get('resync').fire('click'); h.session.receive('state', {...playback, seq: 2, paused: true});
  assert.equal(h.player.paused, true);
});

test('opt-in test build: the player controls (play, pause, seek bar) send server-confirmed commands; no separate party buttons', async () => {
  const h = await playingGuest({guestControl: true, debug: true}), c = controllable(h);
  h.tick();
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.rpcs[0][1].p_playback.paused, true); assert.equal(c.sends[0].payload.paused, true);
  assert.equal(h.player.paused, true); assert.equal(h.sync(), true);
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.rpcs[1][1].p_playback.paused, false); assert.equal(h.player.paused, false);
  h.get('ctlSeek').value = '500'; h.get('ctlSeek').fire('change');
  assert.equal(h.player.currentTime, 60);
  h.player.fire('seeking'); h.player.fire('seeked'); await settlePlayback();
  assert.deepEqual([c.rpcs[2][1].p_playback.position_ms, c.rpcs[2][1].p_playback.paused], [60000, false]);
  delete h.session.room.info.host_only; h.tick(); // A snapshot without the field never grants control.
  assert.equal(JSON.parse(h.get('watchSection').children.at(-1).children.at(-1).textContent).controlBlockedReason, 'host_only_missing');
});

test('diagnostics add resolution, bandwidth, buffer, segment timing and realtime latency without URLs', async () => {
  const h = await harness({debug: true});
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/diag.m3u8'});
  h.get('loadStream').fire('click'); const instance = h.desktopHls();
  instance.bandwidthEstimate = 4200000; instance.levels = [{height: 1080}, {height: 720}];
  instance.emit(FakeHls.Events.FRAG_LOADED, {frag: {duration: 6, url: privateUrl, stats: {loading: {start: 100, end: 1300}}}});
  Object.assign(h.player, {videoWidth: 1920, videoHeight: 1080, currentTime: 10, buffered: {length: 1, start: () => 0, end: () => 22.5}});
  h.session.now = () => 1250; h.session.receive('state', {...playback, seq: 2, at: 1000});
  h.player.fire('waiting'); h.tick();
  const text = h.get('watchSection').children.at(-1).children.at(-1).textContent, data = JSON.parse(text);
  assert.deepEqual([data.playbackMode, data.videoWidth, data.videoHeight, data.bandwidthKbps, data.qualityVariants], ['hls.js', 1920, 1080, 4200, 2]);
  assert.deepEqual([data.bufferAheadSeconds, data.lastSegmentLoadMs, data.lastSegmentDurationSeconds, data.realtimeLatencyMs, data.bufferingEvents], [12.5, 1200, 6, 250, 1]);
  assert.ok(!text.includes('https://') && !text.includes('INTEGRATION_PRIVATE_SENTINEL'));
});

// --- Premium invite, guest join and player UI (feature/party-premium-ui) ---

const preview = (overrides = {}) => ({
  media: {title: 'Snowfall', meta_type: 'series', season: 2, episode: 10, episode_title: 'Lehrgeld',
    description: '<img src=x onerror=alert(1)>', background: 'javascript:alert(1)', logo: 'https://img.example.test/logo.png',
    source: {filename: 'secret-release.mkv', info_hash: 'abcdef'}},
  host: {display_name: 'Alan', avatar_color: '#123456'}, members: 2, max_members: 8, ...overrides});
async function invite(reply) {
  const h = await harness({rpc: {watch_party_preview: args => { if (reply instanceof Error) throw reply; return reply(args); }}});
  h.get('partyCode').value = '8sz-4cm'; h.get('partyCode').fire('change'); await settlePlayback();
  return h;
}
const allText = element => [element.textContent || '', ...(element.children || []).map(allText)].join(' ');

test('invite renders party metadata safely, rejects unsafe images and never shows the stream source', async () => {
  let asked;
  const h = await invite(args => { asked = args; return preview(); });
  assert.deepEqual({...asked}, {p_code: '8SZ4CM'});
  assert.equal(h.get('inviteHostLine').textContent, 'Alan lädt dich ein'); assert.equal(h.get('inviteTitle').textContent, 'Snowfall');
  assert.equal(h.get('inviteEpisode').textContent, 'S2 E10 · Lehrgeld'); assert.equal(h.get('inviteEpisode').hidden, false);
  assert.equal(h.get('inviteDescription').textContent, '<img src=x onerror=alert(1)>'); // Plain text, never HTML.
  assert.equal(h.get('inviteBackdrop').hidden, true); // javascript: URL rejected.
  assert.equal(h.get('inviteLogo').hidden, false); assert.equal(h.get('inviteLogo').src, 'https://img.example.test/logo.png');
  assert.equal(h.get('inviteHost').textContent, 'Alan'); assert.equal(h.get('inviteHostAvatar').textContent, 'A');
  assert.equal(h.get('inviteSeats').textContent, '2 von 8 belegt');
  assert.deepEqual(h.get('inviteSeatDots').children.map(dot => dot.className || ''), ['on', 'on', '', '', '', '', '', '']);
  assert.equal(h.get('openInNuvio').href, 'https://nuvio.tv/party/8SZ4CM');
  const visible = ['inviteHostLine', 'inviteTitle', 'inviteEpisode', 'inviteDescription', 'preview'].map(id => allText(h.get(id))).join(' ');
  assert.ok(!visible.includes('secret-release') && !visible.includes('abcdef'));
});

test('invite fallbacks: missing metadata, full party, unknown or ended party and invalid codes', async () => {
  const bare = await invite(() => ({media: {}, host: null, members: 0, max_members: 0}));
  assert.equal(bare.get('inviteHostLine').hidden, true);
  assert.equal(bare.get('inviteTitle').textContent, 'Watch Party');
  assert.equal(bare.get('inviteEpisode').hidden, true); assert.equal(bare.get('inviteDescription').hidden, true);
  assert.equal(bare.get('inviteBackdrop').hidden, true); assert.equal(bare.get('inviteSeats').textContent, '–');
  const full = await invite(() => preview({members: 8, max_members: 8}));
  assert.equal(full.get('preview').textContent, 'Diese Party ist voll.');
  const missing = await invite(Object.assign(new Error('party_not_found'), {code: 'party_not_found'}));
  assert.match(missing.get('preview').textContent, /gibt es nicht/);
  const ended = await invite(Object.assign(new Error('party_ended'), {code: 'party_ended'}));
  assert.match(ended.get('preview').textContent, /beendet/);
  const h = await harness(); h.get('partyCode').value = 'ABC'; h.get('partyCode').fire('change'); await settlePlayback();
  assert.match(h.get('preview').textContent, /Party-Code/); assert.equal(h.get('openInNuvio').hidden, true);
});

// Integrated Nuvio sign-in: e-mail/password only without a valid session.
async function signedOutInvite(options = {}) {
  const h = await harness({path: '/party/UXZ83H', ...options}); await settlePlayback();
  h.session.room = null;
  return h;
}

test('no name field: signed-out visitors see e-mail and password; "Jetzt ansehen" signs in and joins in one flow', async () => {
  const h = await signedOutInvite({rpc: {sync_pull_profiles: () => [{profile_index: 2, name: 'Zweit'}, {profile_index: 1, name: '  Alan  '}]}});
  assert.equal(h.get('credentials').hidden, false); assert.equal(h.get('accountLine').hidden, true);
  const joins = []; h.session.join = async (...args) => { joins.push(args); };
  h.get('email').value = 'friend@example.test'; h.get('password').value = 'secret-pw';
  h.get('joinForm').fire('submit'); await settlePlayback();
  assert.deepEqual(h.logins.map(l => ({...l})), [{email: 'friend@example.test', hasPassword: true}]);
  assert.equal(joins.length, 1); assert.deepEqual(joins[0].slice(0, 3), ['UXZ83H', 'Alan', null]); // Lowest profile index.
  assert.equal(joins[0][3], undefined); // No anonymous option is ever passed.
  assert.equal(h.get('password').value, ''); // Not kept.
  assert.equal(h.anonymousSignIns.length, 0);
  assert.equal(h.get('credentials').hidden, true); assert.equal(h.get('accountLine').hidden, false);
});

test('an existing session joins directly without credentials; the cover play button uses the same flow', async () => {
  const session = {user: {id: 'u1', is_anonymous: false, email: 'me@example.test', user_metadata: {}}};
  const h = await signedOutInvite({rpc: {session}});
  assert.equal(h.get('credentials').hidden, true); assert.equal(h.get('accountLine').hidden, false);
  const joins = []; h.session.join = async (...args) => { joins.push(args); };
  h.get('invitePlay').fire('click'); await settlePlayback();
  assert.equal(h.logins.length, 0); assert.equal(joins.length, 1);
  assert.equal(joins[0][1], 'Nuvio-Mitglied'); // No profile, no metadata name → neutral, never the e-mail.
});

test('wrong password: clear message, no join; missing fields ask for credentials without any request', async () => {
  const h = await signedOutInvite({rpc: {loginError: true}});
  h.session.join = async () => assert.fail('must not join after a failed sign-in');
  h.get('joinForm').fire('submit'); await settlePlayback();
  assert.equal(h.logins.length, 0); assert.match(h.get('message').textContent, /E-Mail und Passwort eingeben/);
  h.get('email').value = 'friend@example.test'; h.get('password').value = 'wrong';
  h.get('joinForm').fire('submit'); await settlePlayback();
  assert.equal(h.logins.length, 1); assert.match(h.get('message').textContent, /Anmeldung fehlgeschlagen/);
  assert.ok(!h.get('message').textContent.includes('wrong')); assert.equal(h.get('password').value, '');
  assert.equal(h.get('joinButton').disabled, false); assert.equal(h.get('joinButton').textContent, 'Jetzt ansehen');
});

test('double clicks cannot sign in or join twice', async () => {
  const h = await signedOutInvite();
  let release; const joins = [];
  h.session.join = (...args) => { joins.push(args); return new Promise(resolve => { release = resolve; }); };
  h.get('email').value = 'friend@example.test'; h.get('password').value = 'pw';
  h.get('joinForm').fire('submit'); h.get('invitePlay').fire('click'); h.get('joinForm').fire('submit');
  await settlePlayback();
  assert.equal(h.logins.length, 1); assert.equal(joins.length, 1); assert.equal(h.get('joinButton').disabled, true);
  release(); await settlePlayback(); assert.equal(h.get('joinButton').disabled, false);
});

test('display name: profile name, then account metadata; e-mail addresses are never published', async () => {
  const pick = async (rpc, user = {}) => {
    const h = await signedOutInvite({rpc: {session: {user: {id: 'u1', is_anonymous: false, email: 'me@example.test', ...user}}, ...rpc}});
    let name; h.session.join = async (_code, value) => { name = value; };
    h.get('joinForm').fire('submit'); await settlePlayback(); return name;
  };
  assert.equal(await pick({sync_pull_profiles: () => [{profile_index: 1, name: 'me@example.test'}]}, {user_metadata: {full_name: 'Alan P'}}), 'Alan P');
  assert.equal(await pick({sync_pull_profiles: () => { throw Error('offline'); }}, {user_metadata: {name: 'friend@mail.test', username: 'Sam'}}), 'Sam');
  assert.equal(await pick({}, {user_metadata: {display_name: 'x'.repeat(80)}}), 'x'.repeat(36));
  assert.equal(await pick({}, {user_metadata: {email: 'me@example.test'}}), 'Nuvio-Mitglied');
});

test('an expired session shows the sign-in fields again; the guest-join flag never signs in anonymously', async () => {
  const session = {user: {id: 'u1', is_anonymous: false, user_metadata: {}}};
  const h = await signedOutInvite({rpc: {session}, guestJoin: true});
  h.session.join = async () => { throw Object.assign(new Error('JWT expired'), {code: 'PGRST301'}); };
  h.get('joinForm').fire('submit'); await settlePlayback();
  assert.equal(h.get('credentials').hidden, false); assert.match(h.get('message').textContent, /Sitzung ist abgelaufen/);
  const anon = await signedOutInvite({rpc: {session: {user: {id: 'a', is_anonymous: true}}}, guestJoin: true});
  anon.session.join = async () => assert.fail('anonymous sessions must not join');
  anon.get('joinForm').fire('submit'); await settlePlayback();
  assert.equal(anon.anonymousSignIns.length, 0); assert.equal(anon.get('credentials').hidden, false);
});

test('password visibility toggle', async () => {
  const h = await signedOutInvite(); h.get('password').type = 'password';
  h.get('passwordToggle').fire('click'); assert.equal(h.get('password').type, 'text'); assert.equal(h.get('passwordToggle').textContent, 'Verbergen');
  h.get('passwordToggle').fire('click'); assert.equal(h.get('password').type, 'password');
});

test('participant list renders names as text with host and own badges', async () => {
  const h = await harness();
  h.session.room.memberId = 'guest';
  h.session.room.members = [{id: 'host', display_name: 'Alan'}, {id: 'guest', display_name: '<img src=x onerror=alert(1)>'}];
  h.session.handlers.room(h.session.room);
  const items = h.get('memberList').children;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.children.map(child => child.textContent)), [['A', 'Alan', 'Host'], ['<', '<img src=x onerror=alert(1)>', 'Du']]);
  assert.equal(h.get('watchSection').hidden, false); assert.equal(h.get('inviteView').hidden, true);
});

test('the big play button loads the shared stream and starts following the party once metadata arrives', async () => {
  const h = await harness();
  h.session.playback = {...playback, paused: false};
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://cdn.example.test/film.mp4'});
  assert.equal(h.get('loadStream').hidden, false);
  assert.match(h.get('noStream').textContent, /Stream bereit/);
  h.get('loadStream').fire('click');
  assert.equal(h.player.src, 'https://cdn.example.test/film.mp4'); assert.equal(h.sync(), false);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false); assert.equal(h.player.currentTime, 5);
  assert.equal(h.get('syncChip').hidden, false);
  assert.equal(h.get('ctlRemaining').textContent, '1:55'); // Remaining time, as in the reference player.
});

test('time formatting and quality note cover hours, unknown durations and native HLS', async () => {
  const h = await harness(); h.player.canPlayType = () => 'maybe';
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/ios.m3u8'});
  h.get('loadStream').fire('click');
  Object.assign(h.player, {duration: 7325, currentTime: 3725}); h.tick();
  assert.equal(h.get('ctlRemaining').textContent, '1:00:00');
  assert.equal(h.get('qualityNote').hidden, false);
  h.player.duration = NaN; h.tick(); assert.equal(h.get('ctlSeek').disabled, true);
});

// --- XL player, drawer and simplified invite (final master) ---

test('page markup: no banner headline, no hint bar, no permanent side column; code input only as fallback', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('Du bist zu einer Watch Party eingeladen'));
  assert.ok(!html.includes('Gib deinen Namen ein und klicke'));
  assert.ok(!html.includes('id="sidePanel"') && !html.includes('id="partyControls"'));
  assert.match(html, /<label id="codeFallback"[^>]*hidden/);
  assert.match(html, /<p id="message"[^>]*hidden/);
  assert.match(html, /<aside id="infoDrawer"[^>]*hidden/);
  for (const id of ['ctlPlay', 'ctlBack10', 'ctlFwd10', 'ctlMute', 'ctlSeek', 'ctlFullscreen', 'ctlSubtitles', 'ctlChat', 'ctlBack', 'syncChip', 'resync', 'membersButton']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="resync"[^>]*aria-label="Party-Zeit aktualisieren"[^>]*title="Party-Zeit aktualisieren"[^>]*disabled><svg/); // Refresh icon.
  assert.ok(!html.includes('id="displayName"') && !html.includes('id="authSection"') && !html.includes('id="loginButton"'));
  assert.ok(html.indexOf('id="email"') < html.indexOf('id="password"') && html.indexOf('id="password"') < html.indexOf('id="joinButton"')); // Sign-in inline in the invitation.
});

test('the party code is read from the link; without one the fallback field and a clear notice appear', async () => {
  const linked = await harness({path: '/party/uxz-83h'});
  assert.equal(linked.get('partyCode').value, 'UXZ83H'); assert.equal(linked.get('codeFallback').hidden, true);
  const bare = await harness(); await settlePlayback();
  assert.equal(bare.get('codeFallback').hidden, false);
  assert.match(bare.get('preview').textContent, /keinen gültigen Party-Code/);
  bare.session.room = null; bare.session.join = async () => assert.fail('no join without a valid code');
  bare.get('joinForm').fire('submit'); await settlePlayback();
  assert.match(bare.get('message').textContent, /Party-Code/);
});

test('own controls: ±10 s, fullscreen, drawer, participants strip and connection badge', async () => {
  const h = await playingGuest();
  h.session.room.memberId = 'guest'; h.session.room.info.max_members = 8;
  h.session.room.members = [{id: 'host', display_name: 'Alan'}, {id: 'guest', display_name: 'Sam'}];
  h.session.handlers.room(h.session.room);
  assert.equal(h.get('memberCount').textContent, '2/8 Teilnehmer');
  assert.deepEqual(h.get('memberAvatars').children.map(a => [a.textContent, a.className]), [['A', 'avatar host'], ['S', 'avatar']]);
  assert.equal(h.get('drawerCode').textContent, 'UXZ83H');
  h.get('ctlFwd10').fire('click'); assert.equal(h.player.currentTime, 15);
  h.get('ctlBack10').fire('click'); h.get('ctlBack10').fire('click'); assert.equal(h.player.currentTime, 0);
  let fullscreen = 0; h.get('playerWrap').requestFullscreen = () => { fullscreen++; return Promise.resolve(); };
  h.get('ctlFullscreen').fire('click'); assert.equal(fullscreen, 1);
  h.get('membersButton').fire('click'); assert.equal(h.get('infoDrawer').hidden, false); assert.equal(h.get('drawerScrim').hidden, false);
  h.get('drawerScrim').fire('click'); assert.equal(h.get('infoDrawer').hidden, true);
  h.get('ctlChat').fire('click'); assert.equal(h.get('chatPanel').open, true); h.get('drawerClose').fire('click');
  h.session.handlers.connection('CHANNEL_ERROR'); assert.equal(h.get('syncChip').textContent, 'Verbindung unterbrochen');
  h.session.handlers.connection('SUBSCRIBED'); h.get('resync').fire('click'); h.tick();
  assert.equal(h.get('syncChip').textContent, 'Synchron');
});

test('iOS without element fullscreen falls back to the native video fullscreen', async () => {
  const h = await playingGuest(); let native = 0;
  h.player.webkitEnterFullscreen = () => { native++; };
  h.get('ctlFullscreen').fire('click'); assert.equal(native, 1);
});

test('host-only party paused: Play still plays locally, honestly marked "Nicht synchron"; Party-Zeit aktualisieren returns', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked'); // Party is paused.
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(h.player.paused, false); assert.equal(h.sync(), false);
  assert.match(h.get('message').textContent, /lokal weiter/); assert.equal(h.get('syncChip').textContent, 'Nicht synchron');
  h.tick(); assert.equal(h.player.paused, false); // Not silently re-paused.
  h.get('resync').fire('click'); assert.equal(h.sync(), true); assert.equal(h.player.paused, true);
});

test('a blocked play() is reported instead of a button that seemingly does nothing', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  h.player.play = () => Promise.reject({name: 'NotAllowedError', message: privateUrl});
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.match(h.get('message').textContent, /blockiert/);
  assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
  const idle = await harness(); idle.get('ctlPlay').fire('click');
  assert.match(idle.get('message').textContent, /Share my stream/);
});

test('back arrow returns to the invitation without leaving; "Zurück zur Party" resumes the party time', async () => {
  const h = await playingGuest(); let left = 0; h.session.close = async () => { left++; };
  h.get('ctlBack').fire('click');
  assert.equal(h.get('inviteView').hidden, false); assert.equal(h.get('watchSection').hidden, true);
  assert.equal(h.sync(), false); assert.equal(h.player.paused, true); assert.equal(left, 0);
  assert.equal(h.get('joinButton').textContent, 'Zurück zur Party');
  h.get('joinForm').fire('submit'); await settlePlayback();
  assert.equal(h.get('watchSection').hidden, false); assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
});

// --- One-screen cleanup, title and subtitles ---

test('one-screen watch view: no strip under the player, no PARTY code label, no info icon; participants badge sits top right in the player', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const watch = html.slice(html.indexOf('id="watchSection"'), html.indexOf('</section>', html.indexOf('id="watchSection"')));
  assert.ok(!watch.includes('class="below"') && !watch.includes('id="partyLabel"') && !watch.includes('id="ctlInfo"'));
  assert.ok(!/PARTY\s/.test(watch)); assert.ok(!watch.includes('id="legal"') && !watch.includes('id="controlInfo"'));
  const top = watch.slice(watch.indexOf('class="player-top"'), watch.indexOf('id="controlsBar"'));
  assert.ok(top.includes('id="membersButton"') && top.includes('id="memberCount"'));
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.watch \{ height: 100vh; height: 100svh; overflow: hidden;/);
});

test('player title: series name · season/episode · episode title; films and gaps fall back sensibly', async () => {
  const h = await harness();
  const title = media => { h.session.room.info.media = {meta_type: 'movie', meta_id: 'tt1', ...media}; h.session.handlers.room(h.session.room); return h.get('movieTitle').textContent; };
  assert.equal(title({meta_type: 'series', title: 'Snowfall', season: 2, episode: 10, episode_title: 'Lehrgeld'}), 'Snowfall · S2 E10 · Lehrgeld');
  assert.equal(title({title: 'Inception'}), 'Inception');
  assert.equal(title({title: 'Snowfall', season: 2, episode: 10}), 'Snowfall · S2 E10');
  assert.equal(title({episode_title: 'Lehrgeld'}), 'Lehrgeld');
  assert.equal(title({title: '<b>X</b>'}), '<b>X</b>'); // textContent only.
  assert.equal(title({}), 'Watch Party');
});

test('subtitles: no invented tracks; real hls.js renditions are selectable and "Aus" switches them off', async () => {
  const h = await harness();
  h.get('ctlSubtitles').fire('click');
  assert.equal(h.get('subtitleMenu').hidden, false);
  assert.deepEqual(h.get('subtitleMenu').children.map(c => c.textContent), ['Diese Quelle liefert keine Untertitel.', 'Aus', 'Untertiteldatei laden (.vtt/.srt) …']);
  h.get('ctlSubtitles').fire('click'); assert.equal(h.get('subtitleMenu').hidden, true);
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/subs.m3u8'});
  h.get('loadStream').fire('click'); const instance = h.desktopHls();
  instance.subtitleTracks = [{name: 'Deutsch', lang: 'de'}, {lang: 'en'}]; instance.subtitleTrack = -1;
  instance.emit(FakeHls.Events.SUBTITLE_TRACKS_UPDATED);
  const labels = () => h.get('subtitleMenu').children.map(c => c.textContent);
  assert.deepEqual(labels(), ['Untertitel', 'Aus', 'Deutsch', 'en', 'Untertiteldatei laden (.vtt/.srt) …']);
  h.get('subtitleMenu').children[2].fire('click');
  assert.equal(instance.subtitleTrack, 0); assert.equal(instance.subtitleDisplay, true); assert.equal(h.get('subtitleMenu').hidden, true);
  h.get('subtitleMenu').children[1].fire('click');
  assert.equal(instance.subtitleTrack, -1); assert.equal(instance.subtitleDisplay, false);
});

test('local subtitle files: .srt converts to WebVTT, stays local, and invalid or oversized files are refused', async () => {
  const h = await harness();
  assert.equal(h.run(`srtToVtt('1\\r\\n00:00:01,500 --> 00:00:02,250\\r\\nHallo <i>du</i>')`), 'WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.250\nHallo <i>du</i>');
  const pick = async file => { h.get('subtitleFile').files = [file]; h.get('subtitleFile').fire('change'); await settlePlayback(); };
  await pick({name: 'film.exe', size: 10, text: async () => 'x'}); assert.match(h.get('message').textContent, /\.vtt- oder \.srt/);
  await pick({name: 'film.vtt', size: 3 * 1024 * 1024, text: async () => 'WEBVTT'}); assert.match(h.get('message').textContent, /zu groß/);
  await pick({name: 'film.vtt', size: 10, text: async () => 'not vtt'}); assert.match(h.get('message').textContent, /keine gültige WebVTT/);
  await pick({name: 'Deutsch.srt', size: 60, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nHallo'});
  const track = h.player.children.at(-1);
  assert.equal(track.kind, 'subtitles'); assert.equal(track.label, 'Deutsch'); assert.match(track.src, /^blob:/);
  assert.equal(h.get('subtitleFile').value, '');
  h.get('ctlSubtitles').fire('click');
  const items = h.get('subtitleMenu').children;
  assert.equal(items.find(c => c.textContent === 'Deutsch') !== undefined, true);
  h.session.handlers.media(); // A film change removes local subtitle files.
  h.get('ctlSubtitles').fire('click'); h.get('ctlSubtitles').fire('click');
  assert.ok(!h.get('subtitleMenu').children.some(c => c.textContent === 'Deutsch'));
});

// --- Desktop parity (default): same order and trust model as Nuvio Desktop guests ---

test('default build, host_only=false: Pause, Play and seeking in the player steer the party at once (broadcast first, then persist)', async () => {
  const h = await playingGuest({debug: true}), c = controllable(h, {confirm: false}); // Server echo is not required.
  h.session.handlers.room(h.session.room);
  assert.match(h.get('controlInfo').textContent, /wie bei Desktop-Gästen/);
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends.length, 1); assert.equal(c.sends[0].event, 'state');
  assert.deepEqual([c.sends[0].payload.seq, c.sends[0].payload.member_id, c.sends[0].payload.paused, c.sends[0].payload.media_key], [2, 'guest', true, 'movie|tt1||']);
  assert.equal(c.rpcs[0][0], 'watch_party_update'); assert.equal(c.rpcs[0][1].p_playback, c.sends[0].payload); // Persisted afterwards.
  assert.equal(h.session.playback.seq, 2); // The stale server echo (seq 1) cannot roll it back.
  assert.equal(h.player.paused, true); assert.equal(h.sync(), true); assert.equal(h.get('syncChip').textContent, 'Synchron');
  assert.equal(h.session.diagnostics.lastCommandResult, 'persisted');
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends[1].payload.paused, false); assert.equal(h.player.paused, false);
  h.get('ctlFwd10').fire('click'); h.player.fire('seeking'); h.player.fire('seeked'); await settlePlayback();
  assert.equal(c.sends[2].payload.position_ms, h.player.currentTime * 1000);
  h.tick(); h.tick(); await settlePlayback();
  assert.equal(c.sends.length, 3); // Applying our own states never echoes a command.
});

test('desktop parity: a failed persist keeps the distributed state; a failed broadcast reverts to the party time', async () => {
  const h = await playingGuest(), c = controllable(h);
  h.session.rpc = async () => { throw Object.assign(new Error('permission denied'), {code: '42501'}); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends.length, 1); assert.equal(h.session.playback.seq, 2); assert.equal(h.player.paused, true);
  assert.equal(h.session.diagnostics.lastCommandResult, 'persist_failed');
  const b = await playingGuest(); controllable(b);
  b.session.channel = {send: async () => 'error'};
  b.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(b.session.playback.seq, 1); assert.equal(b.player.paused, false); // Party keeps playing.
  assert.match(b.get('message').textContent, /nicht an die Party gesendet/);
});

test('desktop parity respects host_only: snapshot true blocks, and a persist reply with host_only=true revokes control', async () => {
  const h = await playingGuest(), c = controllable(h); h.session.room.info.host_only = true;
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends.length, 0); assert.equal(c.rpcs.length, 0); assert.equal(h.sync(), false);
  const r = await playingGuest(), rc = controllable(r, {hostOnlyAfter: true});
  r.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(rc.sends.length, 1); // Like Desktop: already distributed before the reply.
  assert.equal(r.session.room.info.host_only, true); assert.equal(r.session.canControl(), false);
  assert.match(r.get('controlInfo').textContent, /nur der Host/);
});

// --- Final cleanup: refresh icon, no footer, one-screen invite ---

test('refresh icon keeps #resync, its label and disabled state, and still triggers the existing resync', async () => {
  const h = await readyGuest();
  const icon = h.get('resync').textContent;
  h.get('resync').fire('click'); h.player.fire('seeked');
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5); // Existing party-time alignment.
  h.session.handlers.connection('CHANNEL_ERROR'); // Code paths that used to overwrite the label.
  h.session.handlers.stream(null); h.session.handlers.media();
  assert.equal(h.get('resync').textContent, icon); assert.equal(h.get('resync').disabled, true);
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("$('resync').textContent")); // The SVG icon is never replaced by text.
});

test('legal footer is gone and the invitation is sized to fit one desktop screen without hiding the form', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="legal"') && !html.includes('Keine Umgehung von DRM') && !css.includes('.legal'));
  assert.match(css, /\.invite-media \{[^}]*height: min\(calc\(min\(780px, 100vw - 32px\) \* 9 \/ 16\), 42vh\)/);
  assert.ok(!/\.(invite|invite-body|step|join-form) \{[^}]*overflow: hidden/.test(css)); // No clipping of the form.
  assert.ok(!/html, body \{[^}]*overflow: hidden/.test(css));
  for (const id of ['email', 'password', 'passwordToggle', 'joinButton']) assert.match(html, new RegExp(`id="${id}"`));
});


test('invitation: no copy-link; "Account erstellen" only signed out, "Abmelden" only signed in', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="copyLink"') && !html.includes('Link kopieren'));
  const accountLine = html.slice(html.indexOf('id="accountLine"'), html.indexOf('</p>', html.indexOf('id="accountLine"')));
  assert.ok(accountLine.includes('id="logoutButton"') && accountLine.includes('>Abmelden<')); // Shown only with a session.
  assert.match(html, /Noch kein Nuvio-Konto\? <a id="signupLink" href="https:\/\/nuvio\.tv\/account\/signup" target="_blank" rel="noopener noreferrer">Account erstellen<\/a>/);
  const credentials = html.slice(html.indexOf('id="credentials"'), html.indexOf('id="accountLine"'));
  assert.ok(credentials.includes('id="signupLink"')); // Hidden together with the sign-in fields.
  const out = await harness({path: '/party/UXZ83H'}); await settlePlayback();
  assert.equal(out.get('credentials').hidden, false);
  const signedIn = await harness({path: '/party/UXZ83H', rpc: {session: {user: {id: 'u1', is_anonymous: false, user_metadata: {}}}}}); await settlePlayback();
  assert.equal(signedIn.get('credentials').hidden, true); assert.equal(signedIn.get('accountLine').hidden, false);
  assert.equal(out.get('accountLine').hidden, true);
  let signedOut = 0; const close = signedIn.session.close.bind(signedIn.session);
  signedIn.session.close = async (...args) => { signedOut++; return close(...args); };
  signedIn.get('logoutButton').fire('click'); await settlePlayback();
  assert.equal(signedOut, 1); assert.equal(signedIn.get('credentials').hidden, false); assert.equal(signedIn.get('accountLine').hidden, true);
  assert.equal(signedIn.get('message').textContent, 'Abgemeldet.');
});

// --- Smooth browser control (0.1.37): no waiting for slow RPCs, no duplicate seeks ---

test('desktop parity: rapid pause/play is not blocked by a slow persist RPC', async () => {
  const h = await playingGuest(), c = controllable(h, {hold: true});
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  h.get('ctlPlay').fire('click'); await settlePlayback();
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.deepEqual(c.sends.map(s => s.payload.paused), [true, false, true]); // All sent while every RPC is still pending.
  assert.deepEqual(c.sends.map(s => s.payload.seq), [2, 3, 4]);
  assert.equal(c.rpcs.length, 3); assert.equal(h.player.paused, true);
  c.release(); c.release(); c.release(); await settlePlayback(); // Late replies.
  assert.equal(h.session.playback.seq, 4); assert.equal(h.player.paused, true);
});

test('repeated ±10 s and seek-bar jumps send exactly one command each, immediately, even during HLS buffering', async () => {
  const h = await playingGuest(), c = controllable(h);
  h.get('ctlFwd10').fire('click'); await settlePlayback();
  h.player.fire('seeking'); h.player.fire('waiting'); // Native events of our own seek; HLS still loading.
  h.get('ctlFwd10').fire('click'); await settlePlayback();
  h.get('ctlBack10').fire('click'); await settlePlayback();
  h.player.fire('seeking'); h.player.fire('seeked'); h.player.fire('canplay'); await settlePlayback();
  assert.deepEqual(c.sends.map(s => s.payload.position_ms), [15000, 25000, 15000]);
  h.tick(); h.tick(); await settlePlayback();
  assert.equal(c.sends.length, 3); // No echo, no re-send after seeked.
});

test('after a reconnect browser control works again; host-only still blocks it', async () => {
  const h = await playingGuest(), c = controllable(h);
  h.session.handlers.connection('CHANNEL_ERROR'); assert.equal(h.sync(), false);
  h.session.handlers.connection('SUBSCRIBED'); h.get('resync').fire('click'); h.player.fire('seeked');
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends.length, 1); assert.equal(c.sends[0].payload.paused, true);
  h.session.room.info.host_only = true; h.get('resync').fire('click'); h.player.fire('seeked');
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.sends.length, 1); // Host-only: no shared command.
});

test('desktop host commands still drive the browser while a browser command is pending', async () => {
  const h = await playingGuest(), c = controllable(h, {hold: true});
  h.get('ctlPlay').fire('click'); // Browser pause (seq 2) broadcast, persist pending.
  await settlePlayback();
  h.session.receive('state', {...playback, seq: 3, member_id: 'host', paused: false, position_ms: 40000});
  assert.equal(h.player.paused, false); assert.equal(h.player.currentTime, 40);
  c.release(); await settlePlayback();
  assert.equal(h.session.playback.seq, 3); // The late persist reply of seq 2 cannot override the host.
});

// --- Host-sequenced guest control (0.1.39, Nuvio Desktop fork host). Written, not executed here. ---
function sequencedHost(h, options) {
  const c = controllable(h, options);
  h.session.receive('status', {member_id: 'host', status: 'ready', commands: 1});
  h.session.handlers.room(h.session.room);
  return {...c, commands: () => c.sends.filter(s => s.event === 'command').map(s => s.payload)};
}

test('host-sequenced: Pause, Play and Seek are commands with their own ID; no browser revision, no RPC, the host state confirms', async () => {
  const h = await playingGuest(), c = sequencedHost(h, {hold: true});
  assert.match(h.get('controlInfo').textContent, /ordnet und bestätigt/);
  h.get('ctlPlay').fire('click'); await settlePlayback();
  const [pause] = c.commands();
  assert.equal(c.sends.length, 1); assert.equal(c.sends[0].event, 'command');
  assert.deepEqual([pause.paused, pause.base_seq, pause.host_member_id, 'seq' in pause], [true, 1, 'host', false]);
  assert.equal(c.rpcs.length, 0); assert.equal(h.player.paused, true); // Optimistic, immediately.
  h.tick(); await settlePlayback(); assert.equal(h.player.paused, true); // The old party state does not take it back.
  h.session.receive('state', {...playback, seq: 2, paused: true, position_ms: pause.position_ms, origin_member_id: 'guest', command_id: pause.command_id});
  assert.equal(h.session.latestCommand.status, 'accepted'); assert.match(h.get('message').textContent, /Pause für alle/);
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(c.commands()[1].paused, false); assert.equal(c.commands()[1].base_seq, 2); assert.equal(h.player.paused, false);
  h.get('ctlFwd10').fire('click'); h.player.fire('seeking'); h.player.fire('seeked'); await settlePlayback();
  assert.equal(c.commands()[2].position_ms, h.player.currentTime * 1000);
  h.tick(); h.tick(); await settlePlayback();
  assert.equal(c.sends.length, 3); assert.equal(c.rpcs.length, 0); // Applying our own commands never echoes.
});

test('host-sequenced: Desktop Play right after a browser Pause plays at once; the later rejection does not revert it', async () => {
  const h = await playingGuest(), c = sequencedHost(h);
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(h.player.paused, true);
  h.session.receive('state', {...playback, seq: 2, member_id: 'host', paused: false, position_ms: 40000}); // Host's own Play.
  await settlePlayback();
  assert.equal(h.player.paused, false); assert.equal(h.player.currentTime, 40);
  h.session.receive('ack', {command_id: c.commands()[0].command_id, member_id: 'host', origin_member_id: 'guest', status: 'rejected', reason: 'superseded', seq: 2});
  await settlePlayback();
  assert.match(h.get('message').textContent, /neuerer Befehl/); assert.equal(h.player.paused, false);
  h.tick(); await settlePlayback();
  assert.equal(c.sends.length, 1); assert.equal(h.player.paused, false);
});

test('host-sequenced: no answer → one retry with the same ID, then the server state; playback follows the party again', async () => {
  const h = await playingGuest(), c = sequencedHost(h);
  h.session.ackTimeoutMs = 2;
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(h.player.paused, true);
  await new Promise(resolve => setTimeout(resolve, 30)); await settlePlayback();
  const [first, retry] = c.commands();
  assert.equal(c.commands().length, 2); assert.equal(first.command_id, retry.command_id);
  assert.equal(h.session.latestCommand.status, 'unknown'); assert.match(h.get('message').textContent, /Keine Antwort vom Host/);
  assert.ok(c.rpcs.some(([name]) => name === 'watch_party_heartbeat'));
  h.tick(); await settlePlayback();
  assert.equal(h.player.paused, false); // The authoritative party state (playing) applies again.
});

test('host-sequenced seeking: drag only previews, release sends once, identical releases and HLS events are not re-sent', async () => {
  const h = await playingGuest(), c = sequencedHost(h);
  h.get('ctlFwd10').fire('click'); await settlePlayback();
  h.player.fire('seeking'); h.player.fire('waiting'); // Own seek; HLS still loading.
  h.get('ctlFwd10').fire('click'); await settlePlayback();
  h.get('ctlSeek').value = '500'; h.get('ctlSeek').fire('input'); h.get('ctlSeek').fire('input');
  assert.equal(c.commands().length, 2); // Dragging is a local preview only.
  h.get('ctlSeek').fire('change'); h.get('ctlSeek').fire('change'); await settlePlayback();
  h.player.fire('seeking'); h.player.fire('seeked'); h.player.fire('canplay'); await settlePlayback();
  h.tick(); h.tick(); await settlePlayback();
  assert.deepEqual(c.commands().map(cmd => cmd.position_ms), [15000, 25000, 60000]);
});

test('a host without the announcement keeps desktop-parity control (state broadcast), even after a legacy status', async () => {
  const h = await playingGuest(), c = controllable(h, {confirm: false});
  h.session.receive('status', {member_id: 'host', status: 'ready'});
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.deepEqual(c.sends.map(s => s.event), ['state']);
});

// --- P0 after 0.1.39: realtime recovery in the player. Written, not executed here. ---
test('lost realtime: playback pauses, a reconnect shows "Verbinde neu …", and SUBSCRIBED restores the party time without a click', async () => {
  const h = await playingGuest();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
  h.session.handlers.connection('CHANNEL_ERROR');
  assert.equal(h.sync(), false); assert.equal(h.player.paused, true);
  assert.equal(h.get('syncChip').textContent, 'Verbindung unterbrochen');
  h.session.handlers.connection('CONNECTING');
  assert.equal(h.get('syncChip').textContent, 'Verbinde neu …'); assert.equal(h.get('connection').textContent, 'Verbinde neu …');
  h.session.handlers.connection('SUBSCRIBED'); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false); // Party time restored automatically.
  assert.equal(h.get('connection').textContent, 'Verbunden');
});

test('the refresh button rebuilds a lost subscription instead of only re-applying the old state', async () => {
  const h = await playingGuest(); let reconnects = 0;
  h.session.reconnect = () => { reconnects++; return Promise.resolve(); };
  h.session.handlers.connection('CLOSED');
  h.get('resync').disabled = false; h.get('resync').fire('click');
  assert.equal(reconnects, 1); assert.equal(h.sync(), false); // Nothing is followed until the channel is back.
  assert.match(h.get('message').textContent, /neu aufgebaut/);
  h.session.handlers.connection('SUBSCRIBED'); await settlePlayback();
  assert.equal(h.sync(), true);
  h.get('resync').fire('click'); assert.equal(reconnects, 1); // Connected: normal resync, no rebuild.
});

test('a deliberate local pause before the connection loss is not overridden by the reconnect', async () => {
  const h = await playingGuest();
  h.get('ctlBack').fire('click'); // Back to the invitation: local pause, sync off.
  assert.equal(h.sync(), false);
  h.session.handlers.connection('CHANNEL_ERROR');
  h.session.handlers.connection('SUBSCRIBED'); await settlePlayback();
  assert.equal(h.sync(), false); assert.equal(h.player.paused, true);
});

// --- Automatic host HLS ("Host-Stream automatisch verwenden"). Written, not executed here. ---
const hostOffer = (url, mediaKeyValue = 'movie|tt1||') => ({media_key: mediaKeyValue, url: 'https://desktop.example.test/film.mkv',
  filename: 'original.mkv', browser_hls: {url}});
const enableAuto = h => { h.get('autoHostStream').checked = true; h.get('autoHostStream').fire('change'); };

test('manual mode (default): a host HLS offer needs the play click and never replaces a personal source', async () => {
  const h = await harness();
  assert.equal(h.get('autoHostStream').checked, false);
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8'));
  assert.equal(h.desktopHls(), null); assert.equal(h.get('loadStream').hidden, false); // Consent click still required.
  const p = await harness(); p.enter(); const personal = p.source().instance;
  p.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8'));
  assert.equal(p.source().active, true); assert.equal(p.source().instance, personal); assert.equal(p.desktopHls(), null);
});

test('automatic mode: the offered host HLS is loaded at once and follows the party time after metadata', async () => {
  const h = await harness();
  enableAuto(h);
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8'));
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a.m3u8');
  assert.equal(h.get('loadStream').hidden, true);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5); // Current party time (5 s).
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8')); // Reconnect re-offers the same source.
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a.m3u8'); assert.equal(h.sync(), true); // No reload.
});

test('automatic mode: a renewed link or a new episode reloads only the new source; pending HLS or other media is ignored', async () => {
  const h = await harness(); enableAuto(h);
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8')); h.metadata(); await settlePlayback();
  const first = h.desktopHls();
  h.session.handlers.stream(hostOffer('https://stream.example.test/a-renewed.m3u8'));
  assert.equal(first.destroyed, true); assert.equal(h.desktopHls().source, 'https://stream.example.test/a-renewed.m3u8');
  h.metadata(); await settlePlayback(); assert.equal(h.sync(), true);
  h.session.handlers.stream(hostOffer('https://stream.example.test/other-film.m3u8', 'movie|tt9||')); // Other film: never used.
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a-renewed.m3u8');
});

test('automatic mode replaces a personal source with a playable host source, but not with a revocation or pending HLS', async () => {
  const h = await harness(); h.enter(); const personal = h.source().instance; enableAuto(h);
  h.session.handlers.stream({...hostOffer(''), browser_hls: {url: null}}); // Host HLS still preparing.
  h.session.handlers.stream(null); // Revocation.
  assert.equal(h.source().active, true); assert.equal(h.source().instance, personal);
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8'));
  assert.equal(h.source().active, false); assert.equal(personal.destroyed, true);
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a.m3u8');
});

test('enabling automatic mode applies the source already offered; revoking sharing stops playback at once', async () => {
  const h = await harness();
  h.session.handlers.stream(hostOffer('https://stream.example.test/a.m3u8'));
  assert.equal(h.desktopHls(), null);
  enableAuto(h);
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a.m3u8');
  h.metadata(); await settlePlayback();
  const instance = h.desktopHls();
  h.session.handlers.stream(null);
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true); assert.equal(h.desktopHls(), null);
});

test('stream URLs are never stored; only the automatic-mode preference may be', async () => {
  const h = await harness(); enableAuto(h);
  h.session.handlers.stream(hostOffer('https://stream.example.test/token=PRIVATE_HOST_SENTINEL.m3u8'));
  assert.ok(!JSON.stringify(h.storageWrites).includes('PRIVATE_HOST_SENTINEL'));
  h.session.handlers.media();
  h.get('autoHostStream').checked = false; h.get('autoHostStream').fire('change'); h.get('autoHostStream').checked = true; h.get('autoHostStream').fire('change');
  assert.equal(h.desktopHls(), null); // The old film's offer is forgotten after a media change.
});
