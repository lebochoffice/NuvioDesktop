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
import {loadRoomTitle, resolveRoomMedia, roomMediaForEpisode} from '../src/room-media.js';
import * as hostShareModule from '../src/host-share.js';

const privateUrl = 'https://media.example.test/private/master?token=INTEGRATION_PRIVATE_SENTINEL';
const vod = {live: false, totalduration: 120, fragments: [{start: 0, duration: 120}]};
const playback = {seq: 1, member_id: 'host', paused: true, position_ms: 5000, rate: 1, at: 1000, media_key: 'movie|tt1||'};

class Element {
  constructor() { this.value = ''; this.style = {}; this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; }
  setAttribute(name, value) { (this.attributes ||= new Map()).set(name, value); }
  getAttribute(name) { return this.attributes?.get(name); }
  focus() { this.focused = true; }
  addEventListener(event, callback) { this.listeners.set(event, [...(this.listeners.get(event) || []), callback]); }
  fire(event, details = {}) { for (const callback of this.listeners.get(event) || []) callback({preventDefault() {}, ...details}); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...children) { this.children = children; }
}
class FakeHls {
  static DefaultConfig = {loader: class XhrLoader {}};
  static Events = {LEVEL_LOADED: 'level', ERROR: 'error', MANIFEST_PARSED: 'manifest', FRAG_LOADED: 'frag', LEVEL_SWITCHED: 'switched', SUBTITLE_TRACKS_UPDATED: 'subtitles'};
  static isSupported() { return true; }
  constructor(config) { this.config = config; this.listeners = new Map(); }
  on(event, callback) { this.listeners.set(event, callback); }
  loadSource(value) { this.source = value; }
  attachMedia() {}
  destroy() { this.destroyed = true; this.source = null; }
  emit(event, data) { this.listeners.get(event)?.(event, data); }
}
// autoHost: stored preference ('0'/'1'); null = first visit (default on). The
// existing tests keep the manual flow, so the default here is a stored 'off'.
// joined: party code remembered in this tab (reload rejoin); fakeJoin records
// joins instead of calling the backend and leaves the room empty until then.
async function harness({debug = false, guestControl = false, guestJoin = false, rpc = null, path = '/', autoHost = false, joined = null, fakeJoin = false, share = null, catalog = null, searchCatalog = null, browserHostShare = false} = {}) {
  const elements = new Map(), storageWrites = [], sent = [], timers = [], historyCalls = [], mediaActions = new Map(), copiedLinks = [];
  const location = {pathname: path, origin: 'https://watch.example.test'};
  let clock = 0, tick = () => {};
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const player = get('player');
  get('preview').textContent = ''; // The HTML starts with an empty preview paragraph.
  get('resync').disabled = true; // Mirrors the initial HTML attribute.
  get('subtitleMenu').hidden = true; get('infoDrawer').hidden = true; // Initially hidden in the HTML.
  Object.assign(player, {paused: true, currentTime: 0, readyState: 0, duration: NaN, currentSrc: '', loadCount: 0,
    seekable: {length: 1, start: () => 0, end: () => 120},
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.fire('pause'); }, play() { this.paused = false; return Promise.resolve(); },
    removeAttribute() { this.currentSrc = ''; }, load() { this.loadCount++; },
    canPlayType() { return ''; },
  });
  let session;
  const joins = [];
  const fakeRoom = () => ({info: {code: 'UXZ83H', media: {meta_type: 'movie', meta_id: 'tt1'}, host_member_id: 'host', host_only: true}, members: []});
  class FakeSession extends ActualPartySession {
    constructor(client, device, handlers) { super(client, device, handlers); session = this; }
    join(...args) { if (!fakeJoin) return super.join(...args); joins.push(args); this.room = fakeRoom(); return Promise.resolve(); }
    now() { return 1000; }
    sendPresence(...args) { sent.push(args); return Promise.resolve(); }
    requestState() { return Promise.resolve(); }
  }
  const anonymousSignIns = [], logins = [];
  let authSession = rpc?.session ?? null;
  const client = {removeChannel: async () => {}, auth: {onAuthStateChange() {}, getSession: async () => ({data: {session: authSession}}),
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
    ...protocol, ...syncPolicy, ...hostShareModule, PersonalHlsSource, personalHlsUrlProblem, Hls: FakeHls, PartySession: FakeSession,
    createClient: () => client, callRpc: (_client, name, args) => { if (rpc?.[name]) return rpc[name](args); throw Error('Unexpected RPC'); }, URL, Blob,
    // Family share Worker double: share.handle(action, body, headers) -> {status, body}.
    fetch: async (url, init) => {
      if (!share) throw Error('Unexpected fetch');
      const reply = await share.handle(String(url).split('/v1/')[1], JSON.parse(init.body), init.headers || {});
      return {status: reply.status, headers: {get: name => reply.headers?.[name] ?? null}, json: async () => reply.body};
    },
    env: {VITE_SUPABASE_URL: 'https://backend.example.test', VITE_SUPABASE_ANON_KEY: 'sb_publishable_TEST', ...(guestControl === true ? {VITE_PARTY_GUEST_CONTROL: '1'} : typeof guestControl === 'string' ? {VITE_PARTY_GUEST_CONTROL: guestControl} : {}), ...(guestJoin ? {VITE_PARTY_GUEST_JOIN: '1'} : {}), ...(share ? {VITE_PARTY_SHARE_WORKER: 'https://share.example.test'} : {}), ...(browserHostShare ? {VITE_PARTY_BROWSER_HOST_SHARE: '1'} : {})},
    document: {getElementById: get, createElement: () => new Element(), createTextNode: data => ({data, textContent: data})}, location, history: {replaceState: (_state, _title, url) => { historyCalls.push(url); location.pathname = url; }},
    window: {confirm: () => true, addEventListener: (event, callback) => windowEvents.set(event, callback)},
    navigator: {clipboard: {writeText: async link => { copiedLinks.push(link); }},
      mediaSession: {setActionHandler: (action, handler) => mediaActions.set(action, handler)}},
    resolveRoomMedia: (type, id, season, episode) => resolveRoomMedia(type, id, season, episode,
      async () => ({ok: true, json: async () => ({meta: catalog})})),
    searchRoomMedia: searchCatalog,
    loadRoomTitle: (type, id) => loadRoomTitle(type, id, async () => ({ok: true, json: async () => ({meta: catalog})})),
    roomMediaForEpisode,
    sessionStorage: {getItem: key => key === 'nuvio-party-debug' ? (debug ? '1' : null) : key === 'nuvio-party-joined' ? joined : 'test-device', setItem: (...args) => storageWrites.push(args)},
    localStorage: {getItem: key => key === 'nuvio-party-auto-host-stream' && autoHost !== null ? (autoHost ? '1' : '0') : null, setItem: (...args) => storageWrites.push(args)},
    crypto: {randomUUID: () => 'test-id'}, performance: {now: () => clock},
    // Timeouts are collected and only run via runTimers().
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: id => { if (id) timers[id - 1] = null; },
  });
  const code = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('import.meta.env', 'env');
  vm.runInContext(code, context);
  await Promise.resolve();
  if (!fakeJoin) {
    session.room = fakeRoom();
    session.playback = playback; session.handlers.room(session.room);
  }
  const source = () => vm.runInContext('personalHls', context);
  const enter = (submitter, url = privateUrl) => { get('personalHlsUrl').value = url; get('personalHlsForm').fire('submit', {submitter}); };
  const metadata = () => { player.readyState = 1; player.duration = 120; player.currentSrc = 'blob:local-test'; player.fire('loadedmetadata'); };
  return {get, player, session, source, enter, metadata, sent, storageWrites, windowEvents, anonymousSignIns, logins, joins, historyCalls, mediaActions, copiedLinks,
    runTimers: () => { const due = timers.splice(0); due.forEach(callback => callback?.()); },
    tick: () => tick(),
    advance: ms => { clock += ms; }, sync: () => vm.runInContext('syncEnabled', context),
    desktopHls: () => vm.runInContext('hls', context), run: code => vm.runInContext(code, context)};
}

test('the premium creation action uses verified media and opens the confirmed host room and invite', async () => {
  const h = await harness({catalog: {id: 'tt1234567', type: 'movie', name: 'Catalog movie'},
    rpc: {session: {access_token: 'test-token', user: {id: 'u', is_anonymous: false, user_metadata: {display_name: 'Host'}}}}});
  await settlePlayback();
  h.session.room = null;
  h.get('roomMediaType').value = 'movie'; h.get('roomMediaId').value = 'https://www.imdb.com/title/tt1234567/';
  const requests = [];
  h.session.create = async (media, name) => {
    requests.push({media, name});
    h.session.room = {info: {id: 'party', code: 'UXZ83H', host_member_id: 'host', host_only: true, media},
      memberId: 'host', members: [{id: 'host', display_name: name}]};
    h.session.handlers.room(h.session.room);
  };
  const link = h.get('roomMediaId').value;
  h.get('roomMediaId').value = '';
  h.get('createRoomManual').fire('click');
  assert.equal(requests.length, 0);
  assert.match(h.get('message').textContent, /gültigen Titel/);
  h.get('roomMediaId').value = link;
  h.get('createRoomManual').fire('click');
  await settlePlayback();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].media.meta_id, 'tt1234567');
  assert.equal(requests[0].name, 'Host');
  assert.equal(h.get('roomOverview').hidden, false);
  assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.get('infoDrawer').hidden, false);
  assert.equal(h.get('tabParty').getAttribute('aria-selected'), 'true');
  assert.equal(h.get('panelHost').hidden, true);
  h.get('roomCopyInvite').fire('click'); await settlePlayback();
  assert.deepEqual(h.copiedLinks, ['https://watch.example.test/party/UXZ83H']);
  assert.equal(h.historyCalls.at(-1), '/party/UXZ83H');
  await h.session.close();
});

test('title search ignores stale replies and requires a verified episode before creating a party without a video URL', async () => {
  const replies = new Map(), id = 'tt1234567';
  const h = await harness({
    catalog: {id, type: 'series', name: 'Confirmed series', videos: [{id: id + ':2:3', season: 2, episode: 3}]},
    searchCatalog: query => new Promise((resolve, reject) => replies.set(query, {resolve, reject})),
    rpc: {session: {access_token: 'test-token', user: {id: 'u', is_anonymous: false, user_metadata: {display_name: 'Host'}}}},
  });
  h.session.room = null;
  const requests = [];
  h.session.create = async media => { requests.push(media); };
  const search = h.get('roomSearch'), results = h.get('roomSearchResults'), button = h.get('createRoomButton');
  search.value = 'Network error'; search.fire('input'); h.runTimers();
  replies.get('Network error').reject(new Error('network error'));
  await settlePlayback();
  assert.match(h.get('roomSearchStatus').textContent, /Verbindung/);
  search.value = 'Old query'; search.fire('input'); h.runTimers();
  search.value = 'Confirmed series'; search.fire('input'); h.runTimers();
  replies.get('Confirmed series').resolve([{id, type: 'series', title: 'Confirmed series', year: '2020'}]);
  await settlePlayback();
  replies.get('Old query').resolve([]);
  await settlePlayback();
  assert.equal(results.children.length, 1);
  assert.match(results.children[0].children[0].children[0].textContent, /Confirmed series · 2020 · Serie/);
  results.children[0].children[0].fire('click');
  await settlePlayback();
  assert.equal(button.disabled, true);
  assert.equal(h.get('roomEpisodePicker').hidden, false);
  h.get('roomSearchSeason').value = '2'; h.get('roomSearchSeason').fire('change');
  assert.equal(button.disabled, true);
  h.get('roomSearchEpisode').value = '3'; h.get('roomSearchEpisode').fire('change');
  assert.equal(button.disabled, false);
  button.fire('click');
  await settlePlayback();
  assert.deepEqual(requests, [{type: 'series', meta_type: 'series', meta_id: id, title: 'Confirmed series',
    season: 2, episode: 3, video_id: id + ':2:3'}]);
});

test('a verified film result enables party creation without manual IMDb or video input', async () => {
  const id = 'tt1234567';
  const h = await harness({
    catalog: {id, type: 'movie', name: 'Verified film', description: 'Film summary'},
    searchCatalog: async () => [{id, type: 'movie', title: 'Film result'}],
    rpc: {session: {access_token: 'test-token', user: {id: 'u', is_anonymous: false, user_metadata: {display_name: 'Host'}}}},
  });
  h.session.room = null;
  const requests = [];
  h.session.create = async media => { requests.push(media); };
  const button = h.get('createRoomButton'), search = h.get('roomSearch');
  button.fire('click');
  assert.equal(requests.length, 0);
  search.value = 'Film result'; search.fire('input'); h.runTimers();
  await settlePlayback();
  h.get('roomSearchResults').children[0].children[0].fire('click');
  assert.equal(button.disabled, true);
  await settlePlayback();
  assert.equal(button.disabled, false);
  button.fire('click');
  await settlePlayback();
  assert.deepEqual(requests, [{type: 'movie', meta_type: 'movie', meta_id: id, title: 'Verified film', description: 'Film summary'}]);
});

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
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod}); h.player.fire('seeked');
  Object.defineProperty(h.player, 'currentTime', {get: () => 0, set: () => {throw Error(privateUrl);}});
  h.get('resync').fire('click');
  assert.equal(h.player.paused, true);
  assert.match(h.get('message').textContent, /nicht anspringen/);
  assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
});

async function readyGuest(options) {
  const h = await harness(options); h.enter(); h.metadata();
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  h.player.fire('seeked'); // The automatic first sync seek has landed.
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

test('internal HLS events preserve sync; host-only prevents native seek defaults while solo permits them', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  h.player.currentTime = 5.2; h.player.fire('seeking'); h.player.fire('seeked');
  assert.equal(h.sync(), true);
  h.session.receive('state', {...playback, seq: 2, paused: false}); await settlePlayback();
  // Queue the browser pause event until after the former one-second timer.
  h.player.pause = () => {h.player.paused = true;};
  h.session.receive('state', {...playback, seq: 3, paused: true});
  h.advance(2000); h.player.fire('pause'); assert.equal(h.sync(), true);
  const position = h.player.currentTime;
  let prevented = false;
  h.player.fire('keydown', {key: 'ArrowRight', preventDefault() { prevented = true; }});
  // Model the browser default only if the actual event handler allowed it.
  if (!prevented) { h.player.currentTime = 55; h.player.fire('seeking'); }
  assert.equal(prevented, true);
  assert.equal(h.player.currentTime, position);
  assert.equal(h.sync(), true);
  h.get('ctlSolo').fire('click');
  prevented = false;
  h.player.fire('keydown', {key: 'ArrowRight', preventDefault() { prevented = true; }});
  if (!prevented) { h.player.currentTime = 55; h.player.fire('seeking'); }
  assert.equal(prevented, false);
  assert.equal(h.player.currentTime, 55);
  assert.equal(h.run('soloMode'), true);
  assert.equal(h.sync(), false);
});

test('local diagnostics are opt-in, show only allowlisted fields and never reflect raw error or state payloads', async () => {
  const off = await harness(); off.tick(); assert.equal(off.get('diagnosticsPanel').children.length, 0);
  const h = await harness({debug: true}); h.enter(); h.metadata();
  h.player.play = () => Promise.reject({name: 'NotAllowedError', message: privateUrl});
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  h.session.diagnostics.url = privateUrl; h.session.diagnostics.error = privateUrl;
  h.session.receive('state', {...playback, seq: 2, paused: false, token: privateUrl}); await settlePlayback();
  h.get('resync').fire('click'); await settlePlayback(); h.tick();
  const text = h.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent;
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
  const rpcs = [], sends = [], statuses = [], pending = [];
  h.session.room.memberId = 'guest';
  h.session.room.info.host_only = false;
  // Informational status/position reports are kept apart from control traffic.
  h.session.channel = {send: async message => { (message.event === 'status' ? statuses : sends).push(message); return 'ok'; }};
  h.session.client.removeChannel = async () => {};
  h.session.rpc = (name, args) => {
    rpcs.push([name, args]);
    const reply = () => ({party: {...h.session.room?.info, host_only: hostOnlyAfter,
      playback: confirm ? {...args.p_playback} : {...playback}}});
    if (!hold) return Promise.resolve(reply());
    return new Promise(resolve => pending.push(() => resolve(reply())));
  };
  return {rpcs, sends, statuses, release: () => pending.shift()?.()};
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
  ios.tick(); assert.equal(JSON.parse(ios.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent).playbackMode, 'native-hls');

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
  const data = JSON.parse(h.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent);
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
  assert.equal(JSON.parse(h.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent).controlBlockedReason, 'host_only_missing');
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
  const text = h.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent, data = JSON.parse(text);
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

test('no name field: signed-out visitors see e-mail and password; "Party beitreten" signs in and joins in one flow', async () => {
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
  assert.equal(joins[0][1], 'me'); // No profile or metadata name: the part before "@", never the full e-mail.
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
  assert.equal(h.get('joinButton').disabled, false); assert.equal(h.get('joinButton').textContent, 'Party beitreten');
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
  assert.equal(await pick({}, {user_metadata: {email: 'me@example.test'}}), 'me'); // Local part of the account e-mail.
  assert.equal(await pick({}, {email: 'x@example.test'}), 'Nuvio-Mitglied'); // Too short: neutral fallback.
  assert.equal(await pick({}, {email: '', user_metadata: {}}), 'Nuvio-Mitglied');
  for (const name of [await pick({}, {email: 'max.mustermann@example.test'})]) assert.ok(!name.includes('@') && name === 'max.mustermann');
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
  assert.deepEqual(items.map(item => item.children.map(child => child.textContent)), [['Alan', 'Host', 'Kein Status'], ['<img src=x onerror=alert(1)>', 'Du', 'Kein Status']]);
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
  for (const id of ['ctlPlay', 'ctlBack10', 'ctlFwd10', 'ctlMute', 'ctlSeek', 'ctlFullscreen', 'ctlSubtitles', 'ctlSettings', 'ctlBack', 'syncChip', 'resync', 'membersButton']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="ctlSolo"[\s\S]*id="ctlSubtitles"[\s\S]*id="ctlSettings"[\s\S]*id="ctlFullscreen"/);
  assert.match(html, /id="resync"[^>]*aria-label="Party-Zeit aktualisieren"[^>]*title="Party-Zeit aktualisieren"[^>]*disabled><svg/); // Refresh icon.
  assert.ok(!html.includes('id="displayName"') && !html.includes('id="authSection"') && !html.includes('id="loginButton"'));
  assert.ok(html.indexOf('id="email"') < html.indexOf('id="password"') && html.indexOf('id="password"') < html.indexOf('id="joinButton"')); // Sign-in inline in the invitation.
});

test('the party code is read from the link; without one the plain join form appears without an error', async () => {
  const linked = await harness({path: '/party/uxz-83h', fakeJoin: true});
  assert.equal(linked.get('partyCode').value, 'UXZ83H'); assert.equal(linked.get('codeFallback').hidden, true);
  const bare = await harness({fakeJoin: true}); await settlePlayback();
  assert.equal(bare.get('codeFallback').hidden, false);
  assert.equal(bare.get('preview').textContent, ''); // Home page: no red notice.
  const broken = await harness({path: '/party/abc', fakeJoin: true}); await settlePlayback();
  assert.match(broken.get('preview').textContent, /keinen gültigen Party-Code/); // Only a broken invitation link.
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
  h.get('ctlFwd10').fire('click');
  assert.equal(h.player.currentTime, 5);
  assert.equal(h.sync(), true);
  h.get('ctlSolo').fire('click');
  h.get('ctlFwd10').fire('click'); assert.equal(h.player.currentTime, 15);
  h.get('ctlBack10').fire('click'); h.get('ctlBack10').fire('click'); assert.equal(h.player.currentTime, 0);
  h.get('ctlSolo').fire('click'); await settlePlayback(); h.player.fire('seeked');
  assert.equal(h.sync(), true);
  let fullscreen = 0; h.get('playerWrap').requestFullscreen = () => { fullscreen++; return Promise.resolve(); };
  h.get('ctlFullscreen').fire('click'); assert.equal(fullscreen, 1);
  h.get('membersButton').fire('click'); assert.equal(h.get('infoDrawer').hidden, false); assert.equal(h.get('drawerScrim').hidden, false);
  h.get('drawerScrim').fire('click'); assert.equal(h.get('infoDrawer').hidden, true);
  h.get('ctlSettings').fire('click'); h.get('tabAdvanced').fire('click'); assert.equal(h.get('panelAdvanced').hidden, false); h.get('drawerClose').fire('click');
  h.session.handlers.connection('CHANNEL_ERROR'); assert.equal(h.get('syncChip').textContent, 'Verbindung unterbrochen');
  h.session.handlers.connection('SUBSCRIBED'); h.get('resync').fire('click'); h.tick();
  assert.equal(h.get('syncChip').textContent, 'Synchron');
});

test('participants are a tab of the one drawer, tabs support keyboard navigation and Escape restores focus', async () => {
  const h = await harness();
  h.get('membersButton').fire('click');
  assert.equal(h.get('panelPeople').hidden, false);
  assert.equal(h.get('panelParty').hidden, true);
  assert.equal(h.get('partyApp').inert, true);
  h.get('tabPeople').fire('keydown', {key: 'ArrowRight'});
  assert.equal(h.get('panelPeople').hidden, true);
  assert.equal(h.get('panelAdvanced').hidden, false);
  assert.equal(h.get('tabAdvanced').getAttribute('aria-selected'), 'true');
  assert.equal(h.get('tabAdvanced').focused, true);
  h.windowEvents.get('keydown')({key: 'Escape', preventDefault() {}});
  assert.equal(h.get('infoDrawer').hidden, true);
  assert.equal(h.get('partyApp').inert, false);
  assert.equal(h.get('membersButton').focused, true);
});

test('iOS without element fullscreen falls back to the native video fullscreen', async () => {
  const h = await playingGuest(); let native = 0;
  h.player.webkitEnterFullscreen = () => { native++; };
  h.get('ctlFullscreen').fire('click'); assert.equal(native, 1);
});

test('host-only paused party blocks Play until explicit solo; returning restores the paused host time', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked'); // Party is paused.
  const control = controllable(h); h.session.room.info.host_only = true;
  const position = h.player.currentTime;
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(h.player.paused, true); assert.equal(h.sync(), true);
  assert.equal(h.player.currentTime, position);
  assert.equal(control.sends.length, 0); assert.equal(control.rpcs.length, 0);
  assert.match(h.get('message').textContent, /Host steuert die Wiedergabe.*Allein schauen/);
  h.get('ctlSolo').fire('click');
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(h.player.paused, false); assert.equal(h.sync(), false);
  h.tick(); assert.equal(h.player.paused, false);
  assert.equal(control.sends.length, 0); assert.equal(control.rpcs.length, 0);
  h.get('ctlSolo').fire('click');
  assert.equal(h.sync(), true); assert.equal(h.player.paused, true);
  assert.equal(h.player.currentTime, position);
});

test('a blocked play() is reported instead of a button that seemingly does nothing', async () => {
  const h = await readyGuest(); h.get('resync').fire('click'); h.player.fire('seeked');
  let playCalls = 0;
  h.player.play = () => {
    playCalls++;
    return Promise.reject({name: 'NotAllowedError', message: privateUrl});
  };
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(playCalls, 0);
  assert.equal(h.player.paused, true); assert.equal(h.sync(), true);
  assert.match(h.get('message').textContent, /Host steuert die Wiedergabe.*Allein schauen/);
  h.get('ctlSolo').fire('click');
  h.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(playCalls, 1);
  assert.match(h.get('message').textContent, /blockiert/);
  assert.ok(!h.get('message').textContent.includes('INTEGRATION_PRIVATE_SENTINEL'));
});

test('host-only consumes seekbar and media actions before mutation; solo allows media controls', async () => {
  const h = await playingGuest(), control = controllable(h);
  h.session.room.info.host_only = true;
  const position = h.player.currentTime;
  let prevented = false;
  h.get('ctlSeek').fire('pointerdown', {preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  h.get('ctlSeek').value = '700';
  h.get('ctlSeek').fire('input');
  h.get('ctlSeek').fire('change');
  h.mediaActions.get('pause')();
  h.mediaActions.get('seekto')({seekTime: 70});
  h.mediaActions.get('seekforward')({seekOffset: 10});
  h.mediaActions.get('seekbackward')({seekOffset: 10});
  assert.equal(h.player.paused, false);
  assert.equal(h.player.currentTime, position);
  assert.equal(h.sync(), true);
  assert.equal(control.sends.length, 0); assert.equal(control.rpcs.length, 0);
  h.get('ctlSolo').fire('click');
  h.mediaActions.get('pause')();
  h.mediaActions.get('seekto')({seekTime: 70});
  assert.equal(h.player.paused, true);
  assert.equal(h.player.currentTime, 70);
  assert.equal(h.run('soloMode'), true);
  assert.equal(control.sends.length, 0); assert.equal(control.rpcs.length, 0);
});

test('Play without a shared stream points to the Browser-HLS switch', async () => {
  const idle = await harness(); idle.get('ctlPlay').fire('click');
  assert.match(idle.get('message').textContent, /Noch kein Browser-Stream freigegeben.*Browser-HLS freigeben/);
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
  assert.equal(c.sends.length, 0); assert.equal(c.rpcs.length, 0); assert.equal(h.sync(), true);
  assert.equal(h.player.paused, false);
  const r = await playingGuest(), rc = controllable(r, {hostOnlyAfter: true});
  r.get('ctlPlay').fire('click'); await settlePlayback();
  assert.equal(rc.sends.length, 1); // Like Desktop: already distributed before the reply.
  assert.equal(r.session.room.info.host_only, true); assert.equal(r.session.canControl(), false);
  assert.match(r.get('controlInfo').textContent, /nur der Host/);
});

test('host-only blocks manual pause seek and keyboard input before changing a synced player', async () => {
  const h = await playingGuest(), controls = controllable(h);
  h.session.room.info.host_only = true;
  const before = h.player.currentTime;
  h.get('ctlPlay').fire('click');
  h.run('seekTo(70)');
  h.get('ctlFwd10').fire('click');
  h.get('ctlBack10').fire('click');
  h.get('playerWrap').fire('keydown', {key: ' ', target: {tagName: 'DIV'}});
  h.player.fire('keydown', {key: 'ArrowRight'});
  await settlePlayback();
  assert.equal(h.player.paused, false);
  assert.equal(h.player.currentTime, before);
  assert.equal(h.sync(), true);
  assert.equal(h.run('soloMode'), false);
  assert.equal(controls.sends.length, 0);
  assert.equal(controls.rpcs.length, 0);
  assert.match(h.get('message').textContent, /Der Host steuert die Wiedergabe/);
});

test('explicit solo permits local control under host-only and returning resumes host synchronization', async () => {
  const h = await playingGuest(), controls = controllable(h);
  h.session.room.info.host_only = true;
  h.run('enterSolo()');
  h.get('ctlPlay').fire('click');
  h.run('seekTo(70)');
  assert.equal(h.player.paused, true);
  assert.equal(h.player.currentTime, 70);
  assert.equal(controls.sends.length, 0);
  assert.equal(controls.rpcs.length, 0);
  h.get('ctlSolo').fire('click');
  await settlePlayback();
  assert.equal(h.run('soloMode'), false);
  assert.equal(h.sync(), true);
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

test('manual mode (switched off): a host HLS offer needs the play click and never replaces a personal source', async () => {
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

// --- Automatic start and "Allein schauen". Written, not executed here. ---
const debugData = h => { h.tick(); return JSON.parse(h.get('diagnosticsPanel').children.at(-1).children.at(-1).textContent); };
const hostShare = url => ({media_key: 'movie|tt1||', url, stream_type: 'hls'});

test('autostart: loaded → synced → playing without any click when the browser allows it', async () => {
  const h = await harness({debug: true}); h.session.playback = {...playback, paused: false, position_ms: 30000};
  h.session.handlers.stream(hostShare('https://stream.example.test/a.m3u8')); h.get('loadStream').fire('click');
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false); assert.equal(h.player.currentTime, 30);
  assert.equal(debugData(h).autoStart, 'playing');
  assert.match(h.get('message').textContent, /Party-Zeit wird übernommen|Stream/);
});

test('autostart: a blocked autoplay starts muted once and offers the sound button; unmuting ends the muted state', async () => {
  const h = await harness({debug: true}); h.session.playback = {...playback, paused: false};
  let attempts = 0;
  h.player.play = function () { attempts++; if (!this.muted) return Promise.reject({name: 'NotAllowedError'}); this.paused = false; return Promise.resolve(); };
  h.session.handlers.stream(hostShare('https://stream.example.test/a.m3u8')); h.get('loadStream').fire('click');
  h.metadata(); await settlePlayback(); await settlePlayback();
  assert.equal(h.player.muted, true); assert.equal(h.player.paused, false); assert.equal(h.sync(), true);
  assert.equal(attempts, 2); assert.match(h.get('message').textContent, /Stumm gestartet/);
  assert.equal(debugData(h).autoStart, 'muted');
  h.get('ctlMute').fire('click'); assert.equal(h.player.muted, false); assert.equal(debugData(h).autoStart, 'playing');
});

test('autostart: when even muted playback is blocked, the state is "blocked" and a manual retry works', async () => {
  const h = await harness({debug: true}); h.session.playback = {...playback, paused: false};
  h.player.play = () => Promise.reject({name: 'NotAllowedError'});
  h.session.handlers.stream(hostShare('https://stream.example.test/a.m3u8')); h.get('loadStream').fire('click');
  h.metadata(); await settlePlayback(); await settlePlayback();
  assert.equal(h.sync(), false); assert.equal(debugData(h).autoStart, 'blocked');
  assert.match(h.get('message').textContent, /blockiert/);
  h.player.play = function () { this.paused = false; return Promise.resolve(); };
  h.get('resync').fire('click'); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
});

test('autostart: a source loaded before the first party state starts as soon as that state arrives', async () => {
  const h = await harness({debug: true}); h.session.playback = null;
  h.session.handlers.stream(hostShare('https://stream.example.test/a.m3u8')); h.get('loadStream').fire('click');
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), false); assert.match(h.get('message').textContent, /Warte auf die Party-Zeit/);
  assert.equal(debugData(h).awaitingPartyState, true);
  h.session.receive('state', {...playback, seq: 2, paused: false, position_ms: 40000}); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 40); assert.equal(h.player.paused, false);
});

test('Allein schauen: playback continues locally, own Play/Pause/Seek send nothing, party states do not touch the player', async () => {
  const h = await playingGuest(), c = controllable(h);
  h.get('ctlSolo').fire('click');
  assert.equal(h.get('ctlSolo').textContent, 'Zur Party'); assert.equal(h.get('syncChip').textContent, 'Allein');
  assert.equal(h.player.paused, false); assert.equal(h.sync(), false); // Stream keeps running.
  h.player.play = function () { this.paused = false; this.fire('play'); return Promise.resolve(); };
  h.get('ctlPlay').fire('click'); await settlePlayback(); // Local pause
  h.get('ctlPlay').fire('click'); await settlePlayback(); // Local play: does not rejoin the party.
  h.get('ctlFwd10').fire('click'); h.player.fire('seeking'); h.player.fire('seeked');
  h.get('ctlSeek').value = '500'; h.get('ctlSeek').fire('change');
  assert.equal(c.sends.length, 0); assert.equal(c.rpcs.length, 0); assert.equal(h.sync(), false);
  const local = h.player.currentTime;
  h.session.receive('state', {...playback, seq: 5, paused: true, position_ms: 1000}); h.tick(); await settlePlayback();
  assert.equal(h.player.paused, false); assert.equal(h.player.currentTime, local);
  assert.equal(h.sent.at(-1)[0], 'behind'); // Presence: not waited for by the coordinator.
});

test('Allein schauen survives a realtime loss; "Zur Party" returns to the current party time', async () => {
  const h = await playingGuest();
  h.get('ctlSolo').fire('click');
  h.session.handlers.connection('CHANNEL_ERROR'); assert.equal(h.player.paused, false); // Not paused by the party.
  h.session.handlers.connection('SUBSCRIBED'); await settlePlayback();
  assert.equal(h.sync(), false); assert.equal(h.get('ctlSolo').textContent, 'Zur Party'); // No automatic rejoin.
  h.session.receive('state', {...playback, seq: 6, paused: false, position_ms: 70000});
  h.get('ctlSolo').fire('click'); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 70);
  assert.equal(h.get('ctlSolo').textContent, 'Allein schauen'); assert.equal(h.get('syncChip').textContent, 'Synchron');
});

test('Allein schauen: a renewed host source continues locally at the same position; a film change ends the mode', async () => {
  const h = await harness(); h.session.playback = {...playback, paused: false};
  h.get('autoHostStream').checked = true; h.get('autoHostStream').fire('change');
  h.session.handlers.stream(hostShare('https://stream.example.test/a.m3u8')); h.metadata(); await settlePlayback();
  h.get('ctlSolo').fire('click'); h.player.currentTime = 50;
  h.session.handlers.stream(hostShare('https://stream.example.test/a-renewed.m3u8'));
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a-renewed.m3u8');
  h.metadata(); await settlePlayback();
  assert.equal(h.player.currentTime, 50); assert.equal(h.sync(), false); assert.equal(h.get('ctlSolo').textContent, 'Zur Party');
  h.session.handlers.media();
  assert.equal(h.get('ctlSolo').textContent, 'Allein schauen'); assert.equal(h.get('ctlSolo').disabled, true);
});

// --- Settings layout, default automatic host stream, clear HLS reasons, member sync, host exit. Written, not executed here. ---
test('the automatic-stream setting is a compact switch: the global full-width input rule cannot stretch it', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(html, /class="setting-row"[\s\S]*Host-Stream automatisch verwenden[\s\S]*Neue Streams automatisch laden[\s\S]*class="switch"><input id="autoHostStream" type="checkbox" role="switch">/);
  assert.match(html, /class="setting-row" title="[^"]*Medienanbieter deine IP/);
  assert.ok(!html.includes('check-row'));
  assert.match(css, /\.switch \{[^}]*flex: none; width: 44px/);
  assert.match(css, /\.switch input \{[^}]*width: 100%; height: 100%; margin: 0; padding: 0; opacity: 0/);
  assert.match(css, /\.setting-text \{[^}]*min-width: 0/);
});

test('first visit: automatic host stream is on and loads a compatible source at once; a stored "off" is respected', async () => {
  const h = await harness({autoHost: null});
  assert.equal(h.get('autoHostStream').checked, true);
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/a.m3u8', stream_type: 'hls'});
  assert.equal(h.desktopHls().source, 'https://stream.example.test/a.m3u8');
  assert.match(h.get('message').textContent, /IP-Adresse/); // Transparent about the disclosure.
  const off = await harness({autoHost: false});
  assert.equal(off.get('autoHostStream').checked, false);
  off.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/a.m3u8', stream_type: 'hls'});
  assert.equal(off.desktopHls(), null);
});

test('an addon stream without browser HLS (e.g. "[TB+] …" MKV) is explained, not silently retried', async () => {
  const h = await harness({autoHost: true});
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://addon.example.test/resolve/film.mkv', name: '[TB+] LeLibrary 4K · HDR', filename: 'film.mkv'});
  assert.equal(h.desktopHls(), null); assert.equal(h.get('loadStream').hidden, true);
  assert.match(h.get('streamInfo').textContent, /Host-Quelle im Browser nicht unterstützt/);
});

test('browser HLS states from the host are shown separately: preparing, denied, failed, then ready loads automatically', async () => {
  const h = await harness({autoHost: true});
  const offer = state => ({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: null, state}});
  h.session.handlers.stream(offer('preparing'));
  assert.match(h.get('noStream').textContent, /wird am Desktop vorbereitet/); assert.match(h.get('streamInfo').textContent, /wird vorbereitet/);
  h.session.handlers.stream(offer('denied')); assert.match(h.get('streamInfo').textContent, /Zugriff verweigert/);
  h.session.handlers.stream(offer('failed')); assert.match(h.get('streamInfo').textContent, /HLS erstellen \/ aktualisieren/);
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: 'https://stream.example.test/ready.m3u8'}});
  assert.equal(h.desktopHls().source, 'https://stream.example.test/ready.m3u8');
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: null}}); // Older host: no state.
  assert.match(h.get('streamInfo').textContent, /wird vorbereitet/);
});

test('member sync: the drawer shows the estimated distance per member; reports of other films or unknown members are ignored', async () => {
  const h = await playingGuest();
  h.session.room.memberId = 'guest';
  h.session.room.members = [{id: 'host', display_name: 'Host'}, {id: 'guest', display_name: 'Ich'}, {id: 'guest2', display_name: 'Ben'}];
  h.session.playback = {...playback, paused: false, position_ms: 5000, at: 1000};
  h.session.receive('status', {member_id: 'guest2', status: 'ready', media_key: 'movie|tt1||', position_ms: 9000, position_at: 1000, playing: false});
  h.session.receive('status', {member_id: 'host', status: 'buffering', media_key: 'movie|tt1||', position_ms: 5000, position_at: 1000, playing: true});
  h.session.receive('status', {member_id: 'stranger', status: 'ready', media_key: 'movie|tt1||', position_ms: 1, position_at: 1000});
  const labels = () => h.get('memberList').children.map(item => item.children.at(-1).textContent);
  assert.deepEqual(labels(), ['Puffert', 'Synchron (+0,0 s)', 'Holt auf (+4,0 s)']);
  h.session.receive('status', {member_id: 'guest2', status: 'ready', media_key: 'movie|tt9||', position_ms: 9000, position_at: 1000});
  assert.equal(h.session.memberStatus.has('guest2'), false);
  assert.equal(h.session.playback.seq, 1); // A report never changes the party state.
});

test('party ended or host left: the loaded source keeps playing alone, without pretending a party; a removal stops it', async () => {
  const h = await playingGuest(), instance = h.source().instance;
  h.session.handlers.closed('ended'); h.session.handlers.ended('Die Party wurde beendet.', 'ended');
  assert.equal(h.player.paused, false); assert.equal(h.source().active, true); assert.equal(instance.destroyed, undefined);
  assert.equal(h.get('syncChip').textContent, 'Allein'); assert.equal(h.get('connection').textContent, 'Nicht verbunden');
  assert.match(h.get('message').textContent, /lokal weiter[\s\S]*keine gemeinsame Party mehr/);
  h.session.room = null;
  h.get('ctlSolo').fire('click'); assert.match(h.get('message').textContent, /Party ist beendet/);
  const r = await playingGuest(), personal = r.source().instance;
  r.session.handlers.closed('removed'); r.session.handlers.ended('Deine Mitgliedschaft in der Party wurde entfernt.', 'removed');
  assert.equal(personal.destroyed, true); assert.equal(r.player.paused, true);
});

test('host change keeps a loaded host source locally; an explicit revocation still stops it', async () => {
  const h = await harness({autoHost: true}); h.session.playback = {...playback, paused: false};
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://stream.example.test/a.m3u8', stream_type: 'hls'}); h.metadata(); await settlePlayback();
  const instance = h.desktopHls();
  h.session.handlers.stream(null, 'host_changed');
  assert.equal(h.desktopHls(), instance); assert.equal(h.player.paused, false); assert.equal(h.get('syncChip').textContent, 'Nicht synchron');
  h.session.handlers.stream(null);
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true);
});

test('the periodic position report is a status event only, about every 10 s, and never a control message', async () => {
  const h = await playingGuest(), c = controllable(h);
  h.tick();
  assert.equal(c.statuses.length, 1); assert.equal(c.sends.length, 0);
  const report = c.statuses[0].payload;
  assert.equal(report.position_ms, h.player.currentTime * 1000); assert.equal(report.playing, true); assert.equal(report.media_key, 'movie|tt1||');
  h.tick(); h.advance(5000); h.tick(); assert.equal(c.statuses.length, 1); // Not more often than every 10 s.
  h.advance(5000); h.tick(); assert.equal(c.statuses.length, 2);
  assert.ok(!JSON.stringify(c.statuses).includes('INTEGRATION_PRIVATE_SENTINEL'));
});

// --- Reload rejoin and the Video-Link block. Written, not executed here. ---
const signedIn = {session: {access_token: 'test', user: {id: 'u1', is_anonymous: false, email: 'me@example.test', user_metadata: {}}}};
const joinedWrites = h => h.storageWrites.filter(([key]) => key === 'nuvio-party-joined').map(([, value]) => value);

test('reload: an active membership of this tab rejoins the same party once, without credentials', async () => {
  const h = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  assert.equal(h.joins.length, 1); assert.equal(h.joins[0][0], 'UXZ83H'); assert.equal(h.logins.length, 0);
  assert.match(h.get('message').textContent, /wieder betreten/);
  assert.deepEqual(joinedWrites(h), ['UXZ83H']); // Only the code is kept; no URL or token.
  h.get('invitePlay').fire('click'); await settlePlayback();
  assert.equal(h.joins.length, 1); // Already a member: no second join.
});

test('reload: no automatic join for another party, without a session, or after leaving', async () => {
  const other = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'ABC234', fakeJoin: true}); await settlePlayback();
  assert.equal(other.joins.length, 0);
  const none = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: '', fakeJoin: true}); await settlePlayback();
  assert.equal(none.joins.length, 0);
  const signedOut = await harness({path: '/party/UXZ83H', joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  assert.equal(signedOut.joins.length, 0); assert.equal(signedOut.logins.length, 0);
});

test('leave, sign-out, removal and party end forget the membership, so a reload does not rejoin', async () => {
  const h = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  h.session.close = async () => {};
  h.get('leaveButton').fire('click'); await settlePlayback();
  assert.equal(joinedWrites(h).at(-1), '');
  const e = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  e.session.handlers.ended('Die Party wurde beendet.', 'ended');
  assert.equal(joinedWrites(e).at(-1), '');
  const o = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  o.session.close = async () => {};
  o.get('logoutButton').fire('click'); await settlePlayback();
  assert.equal(joinedWrites(o).at(-1), '');
});

test('reload rejoin: a party that is full or gone ends the automatic rejoin with a clear message', async () => {
  const h = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: '', fakeJoin: true}); await settlePlayback();
  h.session.join = async () => { throw Object.assign(new Error('party_full'), {code: 'party_full'}); };
  h.session.room = null; h.get('invitePlay').fire('click'); await settlePlayback();
  assert.match(h.get('message').textContent, /Beitritt fehlgeschlagen/);
  assert.equal(joinedWrites(h).at(-1), '');
});

test('compact drawer: Party, Teilnehmer, Erweitert (+Host); no Stream/General/Chat tabs; suggestions in the Party tab', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['tabParty', 'tabPeople', 'tabAdvanced', 'tabHost']) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ['tabStream', 'tabGeneral', 'tabChat', 'participantsView', 'roomBackToPlayer', 'roomOpenDrawer', 'roomMemberCount', 'roomOpenHost', 'roomPeople', 'roomInvite'])
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /Eigene HLS-Quelle/);
  const party = html.slice(html.indexOf('<section id="panelParty"'), html.indexOf('<section id="panelPeople"'));
  assert.match(party, /id="proposalSection" class="room-propose" hidden/);
  assert.match(party, /Für alle Mitglieder lesbar/);
  assert.match(party, /id="roomCopyInvite"/);
  assert.match(party, /id="drawerResync"[^>]*>Mich synchronisieren<\/button>\s*<button id="hostSyncAll"[^>]*\bhidden\b[^>]*>Alle synchronisieren/);
  const host = html.slice(html.indexOf('<section id="panelHost"'), html.indexOf('</section>', html.indexOf('<section id="panelHost"')));
  assert.doesNotMatch(host, /id="hostSyncAll"/);
  const advanced = html.slice(html.indexOf('<section id="panelAdvanced"'), html.indexOf('<section id="panelHost"'));
  assert.match(advanced, /id="autoHostStream"/); assert.match(advanced, /id="chatLog"/);
  assert.match(advanced, /<details class="debug-box">[\s\S]*id="diagnosticsPanel"/);
  assert.match(html, /<div id="streamLegacy" hidden>/); // Status carriers for the source code, never visible.
});

// --- Double click, URL after join, rejoin + host source. Written, not executed here. ---
test('mouse: a single click toggles play/pause once (after the double-click window); a double click only toggles fullscreen', async () => {
  const h = await playingGuest(), c = controllable(h, {confirm: false});
  let fullscreen = 0; h.get('playerWrap').requestFullscreen = () => { fullscreen++; return Promise.resolve(); };
  h.get('playerWrap').fire('pointerdown', {pointerType: 'mouse', target: {closest: () => null}});
  h.player.fire('click', {detail: 1}); h.player.fire('click', {detail: 2}); h.player.fire('dblclick');
  h.runTimers(); await settlePlayback();
  assert.equal(fullscreen, 1); assert.equal(h.player.paused, false); assert.equal(c.sends.length, 0); // No play/pause command.
  h.player.fire('click', {detail: 1});
  assert.equal(h.player.paused, false); // Waits for a possible second click.
  h.runTimers(); await settlePlayback();
  assert.equal(h.player.paused, true); assert.equal(c.sends.length, 1); assert.equal(c.sends[0].payload.paused, true);
});

test('touch: a tap shows or hides the controls and never toggles playback', async () => {
  const h = await playingGuest(), c = controllable(h, {confirm: false});
  h.get('playerWrap').fire('pointerdown', {pointerType: 'touch', target: {closest: () => null}});
  h.player.fire('click', {detail: 1}); h.runTimers(); await settlePlayback();
  assert.equal(h.player.paused, false); assert.equal(c.sends.length, 0);
});

test('a manual join on "/" puts /party/<CODE> into the URL, so a reload finds the same party', async () => {
  const h = await harness({path: '/', rpc: signedIn, joined: '', fakeJoin: true}); await settlePlayback();
  h.get('partyCode').value = 'UXZ83H';
  h.get('invitePlay').fire('click'); await settlePlayback();
  assert.deepEqual(h.historyCalls, ['/party/UXZ83H']); assert.deepEqual(joinedWrites(h), ['UXZ83H']);
  const again = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true}); await settlePlayback();
  assert.equal(again.joins.length, 1); assert.deepEqual(again.historyCalls, []); // Already on the party URL.
});

test('after the reload rejoin the host source is loaded automatically again and follows the party time', async () => {
  const h = await harness({path: '/party/UXZ83H', rpc: signedIn, joined: 'UXZ83H', fakeJoin: true, autoHost: null}); await settlePlayback();
  assert.equal(h.joins.length, 1);
  h.session.playback = {...playback, paused: false, position_ms: 42000};
  h.session.handlers.stream({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: 'https://stream.example.test/again.m3u8'}});
  assert.equal(h.desktopHls().source, 'https://stream.example.test/again.m3u8');
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 42);
});

test('browser HLS processing and unsupported states are shown separately', async () => {
  const h = await harness({autoHost: true});
  const offer = state => ({media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', browser_hls: {url: null, state}});
  h.session.handlers.stream(offer('processing'));
  assert.match(h.get('streamInfo').textContent, /verarbeitet den Stream/); assert.match(h.get('noStream').textContent, /vorbereitet/);
  h.session.handlers.stream(offer('unsupported'));
  assert.match(h.get('streamInfo').textContent, /nicht möglich/);
  assert.equal(h.desktopHls(), null);
});

// --- 0.1.44: shared host video link, suggestions, personal auto-sync ---

const hostLink = (url = 'https://cdn.example.test/movie/index.m3u8?sig=abc', label = 'Video-Link des Hosts', key = 'movie|tt1||') =>
  ({media_key: key, url, stream_type: 'hls', browser_hls: {url, label}});

test('a host video link reaches several browser guests, loads automatically and survives a reconnect re-offer', async () => {
  const guests = [await harness({autoHost: true}), await harness({autoHost: true})];
  for (const h of guests) {
    h.session.receive('stream', {member_id: 'host', stream: hostLink()});
    assert.equal(h.desktopHls().source, 'https://cdn.example.test/movie/index.m3u8?sig=abc');
    assert.match(h.get('streamInfo').textContent, /Video-Link des Hosts/);
    h.metadata(); await settlePlayback();
    assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5); // Party time applied.
    const instance = h.desktopHls();
    h.session.receive('stream', {member_id: 'host', stream: hostLink()}); // state_request answer after a reconnect.
    assert.equal(h.desktopHls(), instance); assert.equal(instance.destroyed, undefined);
  }
});

test('a new guest or a reloaded tab gets the current shared link; a new episode link replaces the old one', async () => {
  const late = await harness({autoHost: true});
  late.session.receive('stream', {member_id: 'host', stream: hostLink()});
  const first = late.desktopHls();
  assert.equal(first.source, 'https://cdn.example.test/movie/index.m3u8?sig=abc');
  late.session.receive('stream', {member_id: 'host', stream: hostLink('https://cdn.example.test/movie/e2.m3u8')});
  assert.equal(first.destroyed, true); assert.equal(late.desktopHls().source, 'https://cdn.example.test/movie/e2.m3u8');
  late.session.receive('stream', {member_id: 'host', stream: hostLink('https://cdn.example.test/other.m3u8', 'x', 'movie|tt9||')});
  assert.equal(late.desktopHls().source, 'https://cdn.example.test/movie/e2.m3u8'); // Other title: ignored.
  late.session.handlers.media();
  assert.equal(late.desktopHls(), null); assert.equal(late.player.paused, true);
});

test('revoking the shared link stops it; invalid links never load; non-host senders are ignored', async () => {
  const h = await harness({autoHost: true});
  h.session.receive('stream', {member_id: 'guest-2', stream: hostLink()}); // Forged host share by another member.
  assert.equal(h.desktopHls(), null);
  h.session.receive('stream', {member_id: 'host', stream: hostLink('http://cdn.example.test/a.m3u8')});
  assert.equal(h.desktopHls(), null); assert.equal(h.get('loadStream').hidden, true);
  h.session.receive('stream', {member_id: 'host', stream: hostLink()}); h.metadata(); await settlePlayback();
  const instance = h.desktopHls();
  h.session.receive('stream', {member_id: 'host', stream: null});
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true); assert.equal(h.get('resync').disabled, true);
});

test('personal HLS stays local even in a party with a Desktop host', async () => {
  const h = await harness(), channel = [];
  h.session.room.memberId = 'guest';
  h.session.channel = {send: async message => { channel.push(message); return 'ok'; }};
  h.enter(h.get('loadPersonalHls'));
  await settlePlayback();
  assert.equal(channel.filter(m => m.event === 'stream_suggest').length, 0);
  assert.equal(channel.filter(m => m.event === 'browser_stream_suggest').length, 0);
  assert.equal(h.get('proposalSection').hidden, true);
  assert.ok(h.source().active);
  assert.ok(!JSON.stringify(h.storageWrites).includes('INTEGRATION_PRIVATE_SENTINEL'));
});

test('a personal VOD follows the party time by itself once it is seekable, with bounded retries', async () => {
  const h = await harness(); h.enter();
  h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  assert.equal(h.sync(), false); // No metadata yet: waits.
  h.metadata();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5); // No Sync click needed.
  const late = await harness(); late.enter();
  late.player.seekable = {length: 0};
  late.metadata(); late.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  assert.equal(late.sync(), false);
  late.runTimers(); assert.equal(late.sync(), false); // Still not seekable: one bounded retry.
  late.player.seekable = {length: 1, start: () => 0, end: () => 120};
  late.runTimers();
  assert.equal(late.sync(), true); assert.equal(late.player.currentTime, 5);
  const never = await harness(); never.enter(); never.player.seekable = {length: 0};
  never.metadata(); never.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod});
  for (let i = 0; i < 40; i++) never.runTimers();
  assert.equal(never.sync(), false); assert.match(never.get('message').textContent, /Party-Zeit aktualisieren/);
  never.player.seekable = {length: 1, start: () => 0, end: () => 120};
  never.runTimers(); never.player.fire('canplay');
  assert.equal(never.sync(), false); // Gave up: only the existing Sync button starts it now.
});

test('watching alone keeps a newly loaded personal VOD independent of the party', async () => {
  const h = await harness({autoHost: true});
  h.session.receive('stream', {member_id: 'host', stream: hostLink()}); h.metadata(); await settlePlayback();
  h.get('ctlSolo').fire('click');
  assert.equal(h.get('ctlSolo').textContent, 'Zur Party');
  h.enter(); h.source().instance.emit(FakeHls.Events.LEVEL_LOADED, {details: vod}); h.metadata();
  h.runTimers();
  assert.equal(h.sync(), false); assert.equal(h.get('ctlSolo').textContent, 'Zur Party'); // No automatic return.
});

test('a TorBox CDN browser source loads for guests and is restored by a reconnect without reloading', async () => {
  const cdn = 'https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0';
  const h = await harness({autoHost: true});
  h.session.receive('stream', {member_id: 'host', stream: {media_key: 'movie|tt1||', url: cdn, stream_type: 'hls', browser_hls: {url: cdn}}});
  assert.equal(h.desktopHls().source, cdn);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5);
  const instance = h.desktopHls();
  h.session.receive('stream', {member_id: 'host', stream: {media_key: 'movie|tt1||', url: cdn, stream_type: 'hls', browser_hls: {url: cdn}}});
  assert.equal(h.desktopHls(), instance);
  h.session.receive('stream', {member_id: 'intruder', stream: null}); // Only the host can revoke.
  assert.equal(instance.destroyed, undefined);
  h.session.receive('stream', {member_id: 'host', stream: null}); // "Share my stream" off.
  assert.equal(instance.destroyed, true);
});

// --- 0.1.46: family share through the protected Worker ---

const FAMILY_URL = 'https://flux-007.wnam.tb-cdn.io/stream/p/master.m3u8?token=FAKE_ACCOUNT_TOKEN_FOR_TESTS';
const familyOffer = (rev = 1) => ({media_key: 'movie|tt1||', url: '', stream_type: 'hls', browser_hls: {url: null, state: 'family', rev}});
function familyWorker({admitted = true, propagate = true} = {}) {
  const calls = [];
  const worker = {calls, admitted, grants: new Set(), handle: async (action, body, headers) => {
    calls.push({action, body, auth: headers.Authorization || ''});
    if (action === 'grant') {
      if (!headers.Authorization) return {status: 401, body: {error: 'auth'}};
      if (!worker.admitted) return {status: 403, body: {error: 'not_admitted'}};
      const grant = `grant-${calls.length}`.padEnd(43, 'x'); worker.grants.add(grant);
      return {status: 200, body: {grant, url: FAMILY_URL, media_key: 'movie|tt1||', rev: 1, propagate_token: propagate, expires_at: Date.now() + 600000}};
    }
    if (action === 'stream') {
      if (!worker.admitted || !worker.grants.has(body.grant)) return {status: 403, body: {error: 'revoked'}};
      return {status: 200, body: {url: FAMILY_URL, media_key: 'movie|tt1||', rev: 1, propagate_token: propagate, expires_at: Date.now() + 600000}};
    }
    return {status: 404, body: {}};
  }};
  return worker;
}
const familySignedIn = {session: {access_token: 'guest-session-jwt', user: {id: 'u1', is_anonymous: false}}};

test('an admitted guest fetches the original address with its own session, loads it, syncs and adds the token to TorBox variants', async () => {
  const share = familyWorker();
  const h = await harness({autoHost: true, share, rpc: familySignedIn});
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  assert.deepEqual(share.calls.map(c => c.action), ['grant']);
  assert.equal(share.calls[0].auth, 'Bearer guest-session-jwt'); assert.equal(share.calls[0].body.device_id, 'test-device');
  const instance = h.desktopHls();
  assert.equal(instance.source, FAMILY_URL); // Token kept unchanged.
  assert.match(h.get('streamInfo').textContent, /TorBox \(Familie\)/);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5); // Party time, no Sync click.
  const opened = [], xhr = {open: (...args) => opened.push(args), setRequestHeader() {}};
  instance.config.xhrSetup(xhr, 'https://flux-007.wnam.tb-cdn.io/stream/p/720.m3u8');
  assert.equal(opened[0][1], 'https://flux-007.wnam.tb-cdn.io/stream/p/720.m3u8?token=FAKE_ACCOUNT_TOKEN_FOR_TESTS');
  opened.length = 0; instance.config.xhrSetup(xhr, 'https://cdn.example.test/other.ts');
  assert.equal(opened.length, 0); // Never to other hosts.
  assert.ok(!JSON.stringify(h.storageWrites).includes('FAKE_ACCOUNT_TOKEN_FOR_TESTS')); // Memory only.
  assert.ok(!JSON.stringify(h.sent).includes('FAKE_ACCOUNT_TOKEN_FOR_TESTS'));
});

test('a reconnect re-offer uses the per-guest grant and does not reload; withdrawing the admission stops playback', async () => {
  const share = familyWorker();
  const h = await harness({autoHost: true, share, rpc: familySignedIn});
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  h.metadata(); await settlePlayback();
  const instance = h.desktopHls();
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  assert.equal(share.calls.at(-1).action, 'stream'); assert.equal(share.calls.at(-1).auth, ''); // Grant only, no session.
  assert.equal(h.desktopHls(), instance); assert.equal(instance.destroyed, undefined);
  share.admitted = false; // Host switched this member off (new rev).
  h.session.receive('stream', {member_id: 'host', stream: familyOffer(2)}); await settlePlayback();
  assert.equal(instance.destroyed, true); assert.equal(h.player.paused, true);
  assert.match(h.get('streamInfo').textContent, /nicht zugelassen/);
});

test('a member who is not admitted, or a build without the Worker, never loads the family source', async () => {
  const share = familyWorker({admitted: false});
  const h = await harness({autoHost: true, share, rpc: familySignedIn});
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  assert.equal(h.desktopHls(), null); assert.match(h.get('streamInfo').textContent, /nicht zugelassen/);
  const plain = await harness({autoHost: true});
  plain.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  assert.equal(plain.desktopHls(), null); assert.match(plain.get('streamInfo').textContent, /nicht eingerichtet/);
  const forged = await harness({autoHost: true, share: familyWorker(), rpc: familySignedIn});
  forged.session.receive('stream', {member_id: 'guest-2', stream: familyOffer()}); await settlePlayback();
  assert.equal(forged.desktopHls(), null); // Only the host's offer triggers a fetch.
});

test('when the host leaves, an admitted guest keeps watching the loaded family source alone', async () => {
  const share = familyWorker();
  const h = await harness({autoHost: true, share, rpc: familySignedIn});
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  h.metadata(); await settlePlayback();
  const instance = h.desktopHls();
  h.session.handlers.ended('Der Host hat die Party verlassen.', 'host_left');
  assert.equal(instance.destroyed, undefined); assert.equal(h.get('ctlSolo').textContent, 'Zur Party');
  h.session.receive('stream', {member_id: 'host', stream: null});
});

test('a throttled family fetch (429) keeps the current state and retries after Retry-After', async () => {
  const share = familyWorker();
  let throttle = 1;
  const handle = share.handle;
  share.handle = async (action, body, headers) => {
    if (throttle-- > 0) return {status: 429, body: {error: 'rate_limited'}, headers: {'Retry-After': '30'}};
    return handle(action, body, headers);
  };
  const h = await harness({autoHost: true, share, rpc: familySignedIn});
  h.session.receive('stream', {member_id: 'host', stream: familyOffer()}); await settlePlayback();
  assert.equal(h.desktopHls(), null);
  assert.match(h.get('streamInfo').textContent, /zu viele Anfragen.*30 s/);
  h.runTimers(); await settlePlayback(); await settlePlayback();
  assert.equal(h.desktopHls().source, FAMILY_URL); // The retry succeeded.
  // A throttled reconnect does not stop the running source.
  const instance = h.desktopHls();
  throttle = 1;
  h.session.receive('stream', {member_id: 'host', stream: familyOffer(2)}); await settlePlayback();
  assert.equal(instance.destroyed, undefined);
});

// --- Phase B: shared start (display only; playback follows the host state) ---

test('the host countdown is shown in server time, never starts playback by itself, and can be cancelled', async () => {
  const h = await harness({autoHost: true});
  h.session.receive('stream', {member_id: 'host', stream: {media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.m3u8', stream_type: 'hls'}});
  h.metadata(); await settlePlayback();
  const plays = []; h.player.play = () => { plays.push(1); h.player.paused = false; return Promise.resolve(); };
  // session.now() is 1000 in the harness (server time), whatever the device clock says.
  h.session.receive('countdown', {member_id: 'host', media_key: 'movie|tt1||', start_at: 4000, seconds: 3});
  assert.match(h.get('message').textContent, /Gemeinsamer Start in 3/);
  assert.equal(plays.length, 0); assert.equal(h.player.paused, true); // No local start.
  h.session.receive('countdown', {member_id: 'host', cancel: true});
  assert.match(h.get('message').textContent, /abgebrochen/);
  h.runTimers();
  assert.match(h.get('message').textContent, /abgebrochen/); // The old ticker stopped.
});

test('countdowns from other members, other titles or invalid lengths are ignored', async () => {
  const h = await harness();
  h.get('message').textContent = 'before';
  h.session.receive('countdown', {member_id: 'guest-2', media_key: 'movie|tt1||', start_at: 4000, seconds: 3});
  h.session.receive('countdown', {member_id: 'host', media_key: 'movie|tt9||', start_at: 4000, seconds: 3});
  h.session.receive('countdown', {member_id: 'host', media_key: 'movie|tt1||', start_at: 4000, seconds: 30});
  assert.equal(h.get('message').textContent, 'before');
});

test('a TorBox link with token shared directly by the host loads automatically and passes the token to TorBox variants only', async () => {
  const keyed = 'https://flux-007.wnam.tb-cdn.io/stream/p/master.m3u8?token=FAKE_ACCOUNT_TOKEN_FOR_TESTS';
  const h = await harness({autoHost: true});
  h.session.receive('stream', {member_id: 'host', stream: {media_key: 'movie|tt1||', url: keyed, stream_type: 'hls', browser_hls: {url: keyed, label: 'TorBox HLS', propagate_token: true}}});
  const instance = h.desktopHls();
  assert.equal(instance.source, keyed);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true); assert.equal(h.player.currentTime, 5);
  const opened = [], xhr = {open: (...args) => opened.push(args), setRequestHeader() {}};
  instance.config.xhrSetup(xhr, 'https://flux-007.wnam.tb-cdn.io/stream/p/720.m3u8');
  assert.equal(opened[0][1], 'https://flux-007.wnam.tb-cdn.io/stream/p/720.m3u8?token=FAKE_ACCOUNT_TOKEN_FOR_TESTS');
  opened.length = 0; instance.config.xhrSetup(xhr, 'https://cdn.example.test/x.ts');
  assert.equal(opened.length, 0);
  assert.ok(!JSON.stringify(h.storageWrites).includes('FAKE_ACCOUNT_TOKEN_FOR_TESTS')); // Memory only.
});

// --- Browser host: room, shared link, proposals ------------------------------
const hostRoom = () => ({info: {id: 'party', code: 'UXZ83H', host_member_id: 'host', host_only: true, max_members: 4,
  media: {type: 'movie', meta_type: 'movie', meta_id: 'tt1', title: 'Film', poster: 'https://img.example.test/p.jpg'}},
  memberId: 'host', members: [{id: 'host', display_name: 'Host'}, {id: 'guest', display_name: 'Gast'}]});
async function hostHarness({browserHostShare = true} = {}) {
  const h = await harness({browserHostShare}), channel = [];
  await settlePlayback(); // Let the invitation bootstrap finish before entering the room.
  h.session.room = hostRoom();
  h.session.channel = {send: async message => { channel.push(message); return 'ok'; }};
  h.session.handlers.room(h.session.room);
  return {h, channel};
}

test('only the host can republish the player position and schedule a shared start', async () => {
  const {h, channel} = await hostHarness();
  assert.equal(h.get('hostSyncAll').hidden, false);
  h.get('roomShareUrl').value = 'https://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback();
  h.metadata(); await settlePlayback();
  h.player.currentTime = 12;
  h.get('hostSyncAll').fire('click'); await settlePlayback();
  const state = () => channel.filter(message => message.event === 'state').at(-1).payload;
  assert.equal(state().position_ms, 12000);
  assert.equal(state().paused, true);
  h.get('hostCountdown').fire('click'); await settlePlayback();
  const countdown = channel.find(message => message.event === 'countdown').payload;
  assert.equal(countdown.seconds, 3);
  assert.equal(countdown.start_at, 4000);
  assert.equal(state().paused, true);
  h.session.now = () => 4000;
  h.runTimers(); await settlePlayback();
  assert.equal(state().paused, false);
  assert.equal(state().position_ms, 12000);
  const sent = channel.length;
  h.session.room.info.host_member_id = 'guest';
  h.session.handlers.room(h.session.room);
  assert.equal(h.get('hostSyncAll').hidden, true);
  assert.equal(h.get('drawerResync').hidden, false);
  h.get('hostSyncAll').fire('click');
  h.get('hostCountdown').fire('click');
  await settlePlayback();
  assert.equal(channel.length, sent);
});

test('the browser host shares a direct link from the drawer without hiding the player', async () => {
  const {h, channel} = await hostHarness();
  assert.equal(h.get('roomOverview').hidden, false); assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.get('infoDrawer').hidden, false);
  assert.equal(h.get('panelParty').hidden, false);
  assert.equal(h.get('panelHost').hidden, true);
  assert.equal(h.get('watchSection').hidden, false);
  assert.equal(h.get('tabHost').hidden, false);
  assert.equal(h.get('memberList').children.length, 2);
  assert.equal(h.get('roomTitle').textContent, 'Film');
  h.get('roomShareUrl').value = 'http://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback();
  assert.match(h.get('roomShareStatus').textContent, /HTTPS/);
  assert.equal(channel.filter(m => m.event === 'stream').length, 0);
  h.get('roomShareUrl').value = 'https://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback(); await settlePlayback();
  const offer = channel.filter(m => m.event === 'stream').at(-1).payload;
  assert.equal(offer.member_id, 'host');
  assert.equal(offer.media_key, 'movie|tt1||');
  assert.ok(Number.isSafeInteger(offer.source_revision));
  assert.deepEqual(offer.stream, {media_key: 'movie|tt1||', url: 'https://cdn.example.test/film.mp4', name: 'Video-Link des Hosts',
    stream_type: 'mp4', headers: {}, response_headers: {}});
  const start = channel.filter(m => m.event === 'state').at(-1).payload;
  assert.equal(start.member_id, 'host'); assert.equal(start.paused, true); assert.equal(start.position_ms, 0);
  assert.equal(h.get('roomOverview').hidden, false); assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.player.src, 'https://cdn.example.test/film.mp4');
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true);
  h.get('drawerScrim').fire('click');
  assert.equal(h.get('infoDrawer').hidden, true);
  assert.equal(h.get('playerWrap').hidden, false);
  // The host's own play becomes the party state for everyone.
  h.get('ctlPlay').fire('click'); h.player.fire('play'); await settlePlayback();
  const playing = channel.filter(m => m.event === 'state').at(-1).payload;
  assert.equal(playing.paused, false); assert.equal(playing.member_id, 'host'); assert.ok(playing.seq > start.seq);
  // Back to the room and stop sharing.
  h.get('roomShowOverview').fire('click');
  assert.equal(h.get('roomOverview').hidden, false);
  h.get('roomStopShare').fire('click'); await settlePlayback();
  const revoked = channel.filter(m => m.event === 'stream').at(-1).payload;
  assert.equal(revoked.member_id, 'host'); assert.equal(revoked.stream, null);
  assert.ok(revoked.source_revision > offer.source_revision);
  assert.equal(h.get('playerWrap').hidden, false);
});

test('the host sees members\' proposals, checks them and only an accepted link is shared', async () => {
  const {h, channel} = await hostHarness();
  h.session.receive('browser_stream_suggest', {member_id: 'stranger', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'});
  assert.equal(h.get('roomProposals').hidden, true); // Not a member in the server snapshot.
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/b.webm?token=PROPOSAL_SENTINEL'});
  assert.equal(h.get('roomProposals').hidden, true);
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/b.webm?sig=PROPOSAL_SENTINEL'});
  assert.equal(h.get('roomProposals').hidden, false);
  let [item] = h.get('roomProposalList').children;
  assert.equal(item.children[0].textContent, 'Gast · WEBM · cdn.example.test');
  assert.ok(!item.children[0].textContent.includes('PROPOSAL_SENTINEL'));
  assert.equal(channel.filter(m => m.event === 'stream').length, 0); // Nothing shared by itself.
  item.children[3].fire('click'); // Ablehnen
  assert.deepEqual(channel.at(-1).payload, {member_id: 'host', target_member_id: 'guest', status: 'declined'});
  assert.equal(h.get('roomProposals').hidden, true);
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/c.mp4'});
  [item] = h.get('roomProposalList').children;
  item.children[2].fire('click'); await settlePlayback(); await settlePlayback(); // Annehmen
  assert.equal(channel.filter(m => m.event === 'stream').at(-1).payload.stream.url, 'https://cdn.example.test/c.mp4');
  assert.deepEqual(channel.filter(m => m.event === 'stream_suggest_result').at(-1).payload, {member_id: 'host', target_member_id: 'guest', status: 'accepted'});
});

test('members propose only valid direct links and see the host\'s decision; the Host tab stays hidden for them', async () => {
  const h = await harness({browserHostShare: true}), channel = [];
  h.session.room.memberId = 'guest';
  h.session.room.members = [{id: 'host', display_name: 'Host'}, {id: 'guest', display_name: 'Gast'}];
  h.session.channel = {send: async message => { channel.push(message); return 'ok'; }};
  h.session.handlers.room(h.session.room);
  assert.equal(h.get('tabHost').hidden, true); // No host controls for members.
  assert.equal(h.get('roomOverview').hidden, false); assert.equal(h.get('roomShareForm').hidden, true); // Waiting room without a source.
  h.get('proposalUrl').value = 'https://cdn.example.test/a.m3u8';
  h.get('proposalForm').fire('submit'); await settlePlayback();
  assert.equal(h.get('proposalSection').hidden, true);
  assert.equal(channel.some(m => m.event === 'stream_suggest' || m.event === 'browser_stream_suggest'), false);
  h.session.receive('status', {member_id: 'host', media_key: 'movie|tt1||', browser_host_links: 1});
  assert.equal(h.get('proposalSection').hidden, false);
  h.get('proposalUrl').value = 'https://localhost/a.mp4';
  h.get('proposalForm').fire('submit'); await settlePlayback();
  assert.equal(channel.filter(m => m.event === 'browser_stream_suggest').length, 0);
  h.get('proposalUrl').value = 'https://cdn.example.test/a.m3u8';
  h.get('proposalForm').fire('submit'); await settlePlayback();
  assert.deepEqual(channel.filter(m => m.event === 'browser_stream_suggest').at(-1).payload,
    {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.m3u8'});
  assert.match(h.get('suggestStatus').textContent, /Host entscheidet/);
  h.session.receive('stream_suggest_result', {member_id: 'host', target_member_id: 'guest', status: 'declined'});
  assert.match(h.get('suggestStatus').textContent, /abgelehnt/);
});

test('locked by default: no browser-host offer, no proposal view, no proposal form; the room explains why', async () => {
  const {h, channel} = await hostHarness({browserHostShare: false});
  assert.equal(h.get('roomShareLocked').hidden, false);
  assert.equal(h.get('roomShareButton').disabled, true); assert.equal(h.get('roomShareUrl').disabled, true);
  h.get('roomShareUrl').value = 'https://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback();
  assert.equal(channel.filter(m => m.event === 'stream' || m.event === 'state').length, 0);
  assert.equal(h.get('roomOverview').hidden, false);
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'});
  assert.equal(h.get('roomProposals').hidden, true); // Unauthenticated, readable by all: not shown.
  h.session.receive('state_request', {member_id: 'guest'}); await settlePlayback();
  assert.equal(channel.filter(m => m.event === 'stream').length, 0); // No unsolicited revocation either.
  assert.equal(h.get('proposalSection').hidden, true);
  // The authorized room functions stay: host tab, invite, host-only, members, end.
  assert.equal(h.get('tabHost').hidden, false);
  h.get('roomCopyInvite').fire('click'); await settlePlayback();
  assert.deepEqual(h.copiedLinks, ['https://watch.example.test/party/UXZ83H']);
});

// --- Private family beta: waiting room and stable sharing --------------------
const memberRoom = () => ({...hostRoom(), memberId: 'guest'});
const sharedMp4 = (url = 'https://cdn.example.test/film.mp4') => ({media_key: 'movie|tt1||', url, name: 'Video-Link des Hosts', stream_type: 'mp4', headers: {}, response_headers: {}});

for (const paused of [true, false]) test(`host reload recovers a TorBox offer once and keeps the existing ${paused ? 'paused' : 'playing'} party time`, async () => {
  const {h, channel} = await hostHarness();
  const state = {...playback, paused, position_ms: 42000};
  const url = 'https://media.tb-cdn.io/v/master.m3u8?token=SYNTHETIC_MEDIA_TOKEN';
  const {stream} = hostShareModule.hostShareStream(url, playback.media_key, true);
  h.session.playback = state;
  h.session.diagnostics.connection = 'SUBSCRIBED';
  h.session.room.members.push({id: 'other'});
  h.session.armSourceRecovery();
  const request = channel.find(message => message.event === 'browser_source_request').payload;
  const reply = {...request, member_id: 'guest', source_revision: 123, stream};
  h.session.receive('browser_source_reply', reply);
  assert.equal(h.desktopHls(), null); // One member has yet to confirm the same revision.
  h.session.receive('browser_source_reply', {...reply, member_id: 'other'});
  assert.equal(h.desktopHls().source, url);
  assert.equal(h.session.hostStream, null);
  h.metadata(); h.player.readyState = 3; h.player.fire('canplay');
  await settlePlayback();
  assert.equal(h.sync(), true);
  assert.equal(h.player.currentTime, 42);
  assert.equal(h.player.paused, paused);
  assert.equal(h.session.playback, state);
  assert.equal(h.session.hostOffer.source_revision, 123);
  assert.match(h.get('message').textContent, /Video wiederhergestellt/);
  const loads = h.player.loadCount;
  h.session.receive('browser_source_reply', reply);
  assert.equal(h.player.loadCount, loads);
  assert.ok(!JSON.stringify(h.storageWrites).includes('SYNTHETIC_MEDIA_TOKEN'));
});

test('the beta shares TorBox HLS only in the browser field and discards local references on exit, kick or end', async () => {
  const url = 'https://media.tb-cdn.io/v/master.m3u8?token=SYNTHETIC_MEDIA_TOKEN';
  const {h: host, channel} = await hostHarness();
  host.get('roomShareUrl').value = url;
  host.get('roomShareForm').fire('submit');
  await settlePlayback();
  const offer = channel.find(message => message.event === 'stream').payload;
  assert.equal(offer.stream.url, '');
  assert.equal(offer.stream.browser_hls.url, undefined);
  assert.equal(offer.stream.browser_hls.family_beta_url, url);
  for (const reason of [null, 'removed', 'ended']) {
    const h = await harness({autoHost: true, browserHostShare: true});
    h.session.room = memberRoom();
    h.session.handlers.room(h.session.room);
    h.session.receive('stream', offer);
    const hls = h.desktopHls();
    assert.equal(hls.source, url);
    assert.equal(hls.config.progressive, true);
    assert.equal((await hls.config.fetchSetup({url: 'seg.ts'}, {})).redirect, 'error');
    h.get('proposalUrl').value = url;
    if (reason) await h.session.finish('Party geschlossen.', reason);
    else await h.session.close(false);
    assert.equal(hls.destroyed, true);
    assert.equal(hls.source, null);
    assert.equal(h.session.receivedBrowserOffer, null);
    assert.equal(h.get('proposalUrl').value, '');
    assert.equal(h.get('roomProposalList').children.length, 0);
    assert.ok(!JSON.stringify(h.storageWrites).includes('SYNTHETIC_MEDIA_TOKEN'));
  }
});

for (const [kind, stream] of [
  ['public', sharedMp4()],
  ['family HLS', hostShareModule.hostShareStream('https://media.tb-cdn.io/v/master.m3u8?token=SYNTHETIC_MEDIA_TOKEN',
    playback.media_key, true).stream],
]) test(`a promoted browser re-offers the ${kind} source at the inherited position without reloading`, async () => {
  const h = await harness({autoHost: true, browserHostShare: true}), sent = [];
  const room = memberRoom();
  h.session.room = room;
  h.session.channel = {send: async message => { sent.push(message); return 'ok'; }};
  h.session.playback = {...playback, paused: false, position_ms: 5000};
  h.session.handlers.room(room);
  h.session.handlers.stream(stream);
  h.metadata(); await settlePlayback();
  const previous = h.session.playback, loads = h.player.loadCount;
  room.info.host_member_id = room.memberId;
  h.session.playback = null;
  h.session.handlers.stream(null, 'host_changed');
  h.session.handlers.room(room);
  h.session.handlers.promoted({stream, playback: previous});
  await settlePlayback();
  const state = sent.filter(message => message.event === 'state').at(-1).payload;
  assert.equal(state.member_id, room.memberId);
  assert.equal(state.position_ms, 5000);
  assert.equal(state.paused, false);
  assert.ok(state.seq > previous.seq);
  assert.equal(h.player.loadCount, loads);
  assert.equal(protocol.browserPartyStream(h.session.hostStream).url, protocol.browserPartyStream(stream).url);
});

test('a remaining guest keeps its family HLS instance and resumes sync only after both successor messages', async () => {
  const h = await harness({autoHost: true, browserHostShare: true});
  const room = memberRoom();
  const stream = hostShareModule.hostShareStream('https://media.tb-cdn.io/v/master.m3u8?token=SYNTHETIC_MEDIA_TOKEN',
    playback.media_key, true).stream;
  h.session.room = room;
  h.session.playback = {...playback, paused: false, position_ms: 50000};
  h.session.handlers.room(room);
  h.session.receive('stream', {member_id: 'host', media_key: playback.media_key, source_revision: 1, stream});
  h.metadata(); await settlePlayback();
  const instance = h.desktopHls(), loads = h.player.loadCount;
  h.player.currentTime = 50;
  h.session.rpc = async () => ({party: {...room.info, host_member_id: 'successor', host_only: false, playback: h.session.playback},
    members: [{id: 'successor'}, {id: 'guest'}]});
  await h.session.refresh();
  assert.equal(h.sync(), false);
  assert.match(h.get('message').textContent, /Synchronisierung wird übernommen/);
  h.session.receive('stream', {member_id: 'successor', media_key: playback.media_key, source_revision: 2, stream});
  assert.equal(h.sync(), false);
  assert.equal(h.player.currentTime, 50);
  h.session.receive('state', {...playback, member_id: 'successor', seq: 0, position_ms: 50000});
  assert.equal(h.sync(), false); // Playback is not proof that the offered source was committed.
  h.session.receive('stream', {member_id: 'successor', media_key: playback.media_key, source_revision: 2, stream, handoff_ready: true});
  assert.equal(h.sync(), true);
  assert.equal(h.desktopHls(), instance);
  assert.equal(h.player.loadCount, loads);
  assert.equal(h.player.currentTime, 50);
  assert.equal(h.run('awaitingHandoff'), false);
});

test('a member joins directly into the player and new sources load independently of the Party drawer', async () => {
  const h = await harness({autoHost: true, browserHostShare: true});
  h.session.room = memberRoom();
  h.session.handlers.room(h.session.room);
  assert.equal(h.get('roomOverview').hidden, false); assert.equal(h.get('playerWrap').hidden, false);
  assert.match(h.get('roomWaiting').textContent, /Warte auf Video vom Host/);
  assert.equal(h.get('roomShareForm').hidden, true); assert.equal(h.get('tabHost').hidden, true);
  assert.equal(h.get('roomTitle').textContent, 'Film');
  assert.deepEqual(h.get('memberList').children.map(item => item.children.slice(0, 2).map(child => child.textContent)),
    [['Host', 'Host'], ['Gast', 'Du']]);
  assert.notEqual(h.get('message').style.borderColor, '#ff6969'); // No error just because nothing is shared.
  // The host shares: the member leaves the waiting room and loads the source automatically.
  h.session.receive('stream', {member_id: 'host', stream: sharedMp4()});
  assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.player.src, 'https://cdn.example.test/film.mp4');
  // A new source replaces the old one; a revocation returns to the waiting room.
  h.session.receive('stream', {member_id: 'host', stream: sharedMp4('https://cdn.example.test/other.mp4')});
  assert.equal(h.player.src, 'https://cdn.example.test/other.mp4');
  h.session.receive('stream', {member_id: 'host', stream: null});
  assert.equal(h.get('playerWrap').hidden, false);
  assert.match(h.get('noStream').textContent, /Warte auf Video vom Host/);
  h.session.receive('stream', {member_id: 'host', stream: sharedMp4()});
  h.get('ctlSettings').fire('click'); h.get('tabParty').fire('click');
  assert.equal(h.get('roomOverview').hidden, false);
  h.session.receive('stream', {member_id: 'host', stream: sharedMp4('https://cdn.example.test/new.mp4')});
  assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.player.src, 'https://cdn.example.test/new.mp4');
  assert.equal(h.get('infoDrawer').hidden, false);
  h.get('drawerClose').fire('click');
  assert.equal(h.get('infoDrawer').hidden, true);
  assert.equal(h.get('playerWrap').hidden, false);
  assert.equal(h.player.src, 'https://cdn.example.test/new.mp4');
});

test('an accepted source change invalidates a queued proposal for the same title', async () => {
  const {h, channel} = await hostHarness();
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/p.mp4'});
  const oldAccept = h.get('roomProposalList').children[0].children[2];
  h.get('roomShareUrl').value = 'https://cdn.example.test/new.mp4';
  h.get('roomShareForm').fire('submit');
  await settlePlayback();
  assert.equal(h.get('roomProposalList').children.length, 0);
  oldAccept.fire('click');
  await settlePlayback();
  assert.deepEqual(channel.filter(message => message.event === 'stream').map(message => message.payload.stream.url),
    ['https://cdn.example.test/new.mp4']);
});

test('a failed offer keeps the previous source, is not resent later, and blocks no further sharing', async () => {
  const {h, channel} = await hostHarness();
  let failStream = true;
  h.session.channel = {send: async message => { channel.push(message); return message.event === 'stream' && failStream ? 'error' : 'ok'; }};
  h.get('roomShareUrl').value = 'https://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback(); await settlePlayback();
  assert.match(h.get('roomShareStatus').textContent, /nicht gesendet/);
  assert.equal(h.session.hostStream, null); assert.equal(h.get('roomOverview').hidden, false);
  assert.equal(channel.filter(m => m.event === 'state').length, 0); // No start state for an offer nobody got.
  h.session.receive('state_request', {member_id: 'guest'}); await settlePlayback();
  assert.equal(channel.filter(m => m.event === 'stream').length, 1); // The failed offer is never resent.
  failStream = false;
  h.get('roomShareUrl').value = 'https://cdn.example.test/film.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback(); await settlePlayback();
  assert.equal(h.session.hostStream.url, 'https://cdn.example.test/film.mp4');
  assert.equal(h.get('playerWrap').hidden, false);
});

test('a failed start state announces the previous offer again; the host keeps its previous source', async () => {
  const {h, channel} = await hostHarness();
  h.get('roomShareUrl').value = 'https://cdn.example.test/first.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback(); await settlePlayback();
  assert.equal(h.session.hostStream.url, 'https://cdn.example.test/first.mp4');
  h.session.channel = {send: async message => { channel.push(message); return message.event === 'state' ? 'error' : 'ok'; }};
  h.get('roomShowOverview').fire('click');
  h.get('roomShareUrl').value = 'https://cdn.example.test/second.mp4';
  h.get('roomShareForm').fire('submit'); await settlePlayback(); await settlePlayback();
  const offers = channel.filter(m => m.event === 'stream').map(m => m.payload.stream?.url);
  assert.deepEqual(offers.slice(-2), ['https://cdn.example.test/second.mp4', 'https://cdn.example.test/first.mp4']);
  assert.equal(h.session.hostStream.url, 'https://cdn.example.test/first.mp4');
  assert.equal(h.player.src, 'https://cdn.example.test/first.mp4');
  assert.match(h.get('roomShareStatus').textContent, /vorherige Freigabe wurde wieder angek/);
});

test('only one share action runs at a time; a failed revocation keeps the source', async () => {
  const {h, channel} = await hostHarness();
  h.get('roomShareUrl').value = 'https://cdn.example.test/a.mp4';
  h.get('roomShareForm').fire('submit');
  h.get('roomShareUrl').value = 'https://cdn.example.test/b.mp4';
  h.get('roomShareForm').fire('submit'); // Still busy with a.mp4.
  await settlePlayback(); await settlePlayback();
  assert.deepEqual(channel.filter(m => m.event === 'stream').map(m => m.payload.stream.url), ['https://cdn.example.test/a.mp4']);
  h.session.channel = {send: async message => { channel.push(message); return message.event === 'stream' ? 'error' : 'ok'; }};
  h.get('roomStopShare').fire('click'); await settlePlayback();
  assert.equal(h.session.hostStream.url, 'https://cdn.example.test/a.mp4');
  assert.equal(h.get('playerWrap').hidden, false); // Still sharing: no false "stopped".
});

test('proposals expire after a kick or a title change and are re-checked before acceptance', async () => {
  const {h, channel} = await hostHarness();
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/p.mp4'});
  assert.equal(h.get('roomProposalList').children.length, 1);
  const [item] = h.get('roomProposalList').children;
  h.session.room.members = h.session.room.members.filter(member => member.id !== 'guest'); // Removed, UI not yet refreshed.
  item.children[2].fire('click'); await settlePlayback(); // Annehmen
  assert.equal(channel.filter(m => m.event === 'stream').length, 0);
  assert.equal(h.get('roomProposals').hidden, true);
  h.session.room.members.push({id: 'guest', display_name: 'Gast'});
  h.session.receive('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/p.mp4'});
  h.session.room.info.media = {...h.session.room.info.media, meta_id: 'tt2'};
  h.session.handlers.room(h.session.room); // Title changed.
  assert.equal(h.get('roomProposals').hidden, true);
});

test('blocked autoplay shows one clear start button; tapping it starts at the party time', async () => {
  const h = await harness({autoHost: true, browserHostShare: true});
  h.session.room = memberRoom();
  h.session.playback = {seq: 2, member_id: 'host', paused: false, position_ms: 5000, rate: 1, at: 1000, media_key: 'movie|tt1||'};
  h.session.handlers.room(h.session.room);
  const blocked = () => Promise.reject(Object.assign(new Error('blocked'), {name: 'NotAllowedError'}));
  const allowed = h.player.play;
  h.player.play = blocked;
  h.session.receive('stream', {member_id: 'host', stream: sharedMp4()});
  h.metadata(); await settlePlayback(); await settlePlayback(); await settlePlayback();
  assert.equal(h.get('autoplayStart').hidden, false);
  assert.match(h.get('message').textContent, /Wiedergabe starten/);
  h.player.play = allowed;
  h.get('autoplayStart').fire('click'); await settlePlayback();
  assert.equal(h.get('autoplayStart').hidden, true);
  assert.equal(h.sync(), true); assert.equal(h.player.paused, false);
});

test('chat toasts: new messages of others appear on the player, at most five, gone after a while; history and own messages do not', async () => {
  const h = await harness();
  h.session.room.memberId = 'guest';
  h.session.room.members = [{id: 'host', display_name: 'Host'}, {id: 'guest', display_name: 'Gast'}];
  h.session.handlers.chat({id: '1', member_id: 'host', body: 'alt'}, true); // History of the first load.
  h.session.handlers.chat({id: '2', member_id: 'guest', body: 'eigene'});  // Own message.
  assert.equal(h.get('chatOverlay').children.length, 0);
  for (let i = 0; i < 7; i++) h.session.handlers.chat({id: String(10 + i), member_id: 'host', body: `Nachricht ${i}`});
  const toasts = h.get('chatOverlay').children;
  assert.equal(toasts.length, 5);
  assert.equal(toasts.at(-1).children.at(-1).textContent ?? toasts.at(-1).children.at(-1).data, 'Nachricht 6');
  assert.equal(h.get('chatLog').children.length, 9); // The full chat log under "Erweitert" keeps everything.
  h.runTimers();
  assert.equal(h.get('chatOverlay').children.length, 0);
});

test('a stalled handoff times out without restarting video and can be retried explicitly', async () => {
  const h = await harness({autoHost: true, browserHostShare: true});
  const room = memberRoom(), stream = sharedMp4();
  h.session.room = room;
  h.session.playback = {...playback, paused: false};
  h.session.handlers.room(room);
  h.session.handlers.stream(stream);
  h.metadata(); await settlePlayback();
  assert.equal(h.sync(), true);
  const loads = h.player.loadCount;

  room.info.host_member_id = 'successor';
  h.session.playback = null;
  h.session.handlers.stream(null, 'host_changed');
  for (let i = 0; i < 5; i++) h.runTimers();
  assert.match(h.get('message').textContent, /Synchronisierung nicht wiederhergestellt/);
  assert.equal(h.sync(), false);
  assert.equal(h.player.paused, false);
  assert.equal(h.player.loadCount, loads);

  h.session.receive('stream', {member_id: 'successor', media_key: playback.media_key, source_revision: 1, stream, handoff_ready: true});
  h.session.receive('state', {...playback, seq: 0, member_id: 'successor'});
  assert.equal(h.sync(), false);
  h.get('resync').fire('click');
  assert.equal(h.sync(), true);
  assert.equal(h.player.loadCount, loads);
});

test('a promoted browser does not re-offer a previously committed source after media failure', async () => {
  const h = await harness({autoHost: true, browserHostShare: true}), sent = [];
  const room = memberRoom(), stream = sharedMp4();
  h.session.room = room;
  h.session.channel = {send: async message => { sent.push(message); return 'ok'; }};
  h.session.handlers.room(room);
  h.session.handlers.stream(stream);
  h.metadata(); await settlePlayback();
  h.player.error = {code: 4};
  h.player.fire('error');
  room.info.host_member_id = room.memberId;
  h.session.playback = null;
  h.session.handlers.stream(null, 'host_changed');
  h.session.handlers.promoted({stream, playback});
  await settlePlayback();
  assert.ok(!sent.some(message => message.event === 'stream'));
  assert.match(h.get('message').textContent, /gültigen Videolink/);
});
