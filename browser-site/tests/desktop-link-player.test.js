// The in-player link view of NUVIO Desktop (composeApp player-ui): same sync
// rules as the browser, its message protocol, and the WebView2 wiring.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as browserPolicy from '../src/link-sync.js';

const ui = name => new URL(`../../composeApp/src/desktopMain/resources/player-ui/${name}`, import.meta.url);
const read = url => readFileSync(url, 'utf8');

function loadPolicy() {
  const context = vm.createContext({URL});
  vm.runInContext(read(ui('link-policy.js')), context);
  return context.NuvioLinkPolicy;
}

test('desktop and browser use the same YouTube sync rules', () => {
  const P = loadPolicy();
  assert.deepEqual({...P.LINK_SYNC}, {...browserPolicy.LINK_SYNC});
  const cases = [];
  for (const state of [-1, 0, 1, 2, 3, 5]) for (const positionS of [0, 99, 100.6, 101.9, 102.5, 590]) for (const partyPaused of [false, true]) {
    cases.push({desiredS: 100, positionS, partyPaused, state, durationS: 600}, {desiredS: 900, positionS, partyPaused, state, durationS: 600});
  }
  for (const input of cases) assert.deepEqual({...P.youTubeAction(input)}, browserPolicy.youTubeAction(input), JSON.stringify(input));
  for (const input of [{state: 2, partyPaused: false, sinceOwnActionMs: 5000}, {state: 1, partyPaused: true, sinceOwnActionMs: 5000},
    {state: 2, partyPaused: false, sinceOwnActionMs: 100}, {state: 1, partyPaused: null, sinceOwnActionMs: 5000}]) {
    assert.equal(P.viewerToggle(input), browserPolicy.viewerToggle(input));
  }
  const desktop = new P.LinkSeekGuard(), browser = new browserPolicy.LinkSeekGuard();
  for (const at of [0, 1000, 5000, 9000, 10000, 15000, 20000, 61000]) {
    assert.equal(desktop.allow(at), browser.allow(at), String(at));
    if (desktop.allow(at)) { desktop.note(at); browser.note(at); }
  }
});

test('files: seek beyond the threshold, calm nudging with hysteresis, wait while buffering', () => {
  const P = loadPolicy();
  const a = input => ({...P.fileAction({desiredS: 100, partyPaused: false, playing: true, buffering: false, durationS: 600, nudging: false, rate: 1, ...input})});
  assert.equal(a({positionS: 102}).kind, 'seek');
  assert.equal(a({positionS: 100.1}).kind, 'in_sync');
  assert.deepEqual(a({positionS: 100.4}), {kind: 'nudge', rate: .95});
  assert.equal(a({positionS: 100.1, nudging: true}).kind, 'nudge'); // Hysteresis: stops only below .08 s.
  assert.equal(a({positionS: 100.05, nudging: true}).kind, 'in_sync');
  assert.equal(a({positionS: 50, buffering: true}).kind, 'wait');
  assert.equal(a({positionS: 100, playing: false}).kind, 'play');
  assert.equal(a({positionS: 100, partyPaused: true}).kind, 'pause');
  assert.equal(P.partyPositionMs({positionMs: 5000, at: 1000, paused: false, rate: 1}, 3000), 7000);
  assert.equal(P.partyPositionMs({positionMs: 5000, at: 1000, paused: true, rate: 1}, 3000), 5000);
  assert.equal(P.safeFileUrl('https://cdn.example.test/a.mp4?sig=1'), true);
  for (const bad of ['http://cdn.example.test/a.mp4', 'https://192.168.0.2/a.mp4', 'https://localhost/a.webm', 'https://cdn.example.test/a.m3u8',
    'https://u:p@cdn.example.test/a.mp4', 'https://cdn.example.test/a.mp4#t=2', 'https://nas.home.arpa/a.mp4']) assert.equal(P.safeFileUrl(bad), false, bad);
});

function linkPage() {
  const posted = [], intervals = [], players = [];
  const element = tag => ({tag, children: [], listeners: {}, style: {}, setAttribute() {}, addEventListener(t, fn) { this.listeners[t] = fn; },
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); }, remove() {}});
  const nodes = {player: element('div'), status: element('p')};
  const parent = {postMessage: message => posted.push(message)};
  let messageHandler = null, clock = 0;
  class Player {
    constructor(frame, {events}) { this.frame = frame; this.events = events; this.calls = []; this.time = 0; this.state = -1; players.push(this); }
    getCurrentTime() { return this.time; } getDuration() { return 600; } getPlayerState() { return this.state; }
    seekTo(s) { this.calls.push(['seek', s]); this.time = s; } playVideo() { this.calls.push('play'); } pauseVideo() { this.calls.push('pause'); } destroy() { this.destroyed = true; }
  }
  const window = {parent, addEventListener: (type, fn) => { if (type === 'message') messageHandler = fn; }};
  const context = vm.createContext({
    window, URL, Promise, Math, Number, JSON, setTimeout: () => 0, clearTimeout() {},
    setInterval: fn => { intervals.push(fn); return 1; }, performance: {now: () => clock}, Date: {now: () => 1000},
    location: {origin: 'https://nuvio-link.example'}, YT: {Player},
    document: {getElementById: id => nodes[id], createElement: element, head: element('head')},
  });
  context.globalThis = context;
  vm.runInContext(read(ui('link-policy.js')), context);
  vm.runInContext(read(ui('link-player.js')), context);
  const send = data => messageHandler({source: parent, data: {nuvioLink: 1, ...data}});
  return {posted, players, nodes, send, tick: () => intervals.forEach(fn => fn()), advance: ms => { clock += ms; },
    forged: data => messageHandler({source: {}, data: {nuvioLink: 1, ...data}})};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const ytSource = (rev = 1) => ({key: `link:abcdefgh23456789:${rev}`, kind: 'youtube', videoId: 'M7lc1UVf-VE', url: null});
const partyState = (rev = 1, extra = {}) => ({key: `link:abcdefgh23456789:${rev}`, seq: 1, paused: false, positionMs: 5000, at: 1000, rate: 1, offsetMs: 0, ...extra});

test('link page: official embed with origin, follows the party calmly, reports viewer actions, solo stops steering', async () => {
  const page = linkPage();
  assert.equal(page.posted[0].type, 'hello');
  page.forged({type: 'source', source: ytSource()}); await settle();
  assert.equal(page.players.length, 0); // Messages from anyone but the parent are ignored.
  page.send({type: 'source', source: ytSource()}); await settle();
  const [player] = page.players;
  const embed = new URL(player.frame.src);
  assert.equal(embed.origin + embed.pathname, 'https://www.youtube.com/embed/M7lc1UVf-VE');
  assert.equal(embed.searchParams.get('origin'), 'https://nuvio-link.example');
  assert.equal(player.frame.referrerPolicy, 'strict-origin-when-cross-origin');
  page.send({type: 'party', party: partyState()});
  player.state = 2; player.events.onReady();
  assert.deepEqual(player.calls, [['seek', 5], 'play']);
  player.state = 1; page.tick(); assert.equal(player.calls.length, 2);
  player.time = 0; page.advance(1000); page.tick(); assert.equal(player.calls.length, 2); // Cooldown: no seek loop.
  player.time = 5;
  page.send({type: 'party', party: partyState(2)}); // A state of another revision is not applied.
  page.advance(5000); player.state = 2; player.events.onStateChange({data: 2});
  const viewer = page.posted.filter(m => m.type === 'viewer');
  assert.equal(viewer.length, 0); // No current party state: nothing to report.
  page.send({type: 'party', party: partyState()});
  page.advance(5000); player.state = 2; player.events.onStateChange({data: 2});
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.filter(m => m.type === 'viewer').at(-1))), {nuvioLink: 1, type: 'viewer', action: 'pause', positionMs: 5000});
  const before = player.calls.length; page.tick(); assert.equal(player.calls.length, before); // Held until the party answers.
  page.send({type: 'solo', solo: true}); page.advance(5000); page.tick(); assert.equal(player.calls.length, before);
  page.send({type: 'local', action: 'seekBy', seconds: 10}); assert.deepEqual(player.calls.at(-1), ['seek', 15]);
  page.send({type: 'solo', solo: false});
  assert.deepEqual(player.calls.slice(-2), [['seek', 5], 'play']); // Back at the party time.
  page.send({type: 'source', source: ytSource(3)}); await settle();
  assert.equal(player.destroyed, true); assert.equal(page.players.length, 2);
  player.events.onStateChange({data: 1}); // Callback of the replaced player: ignored.
  assert.equal(page.posted.filter(m => m.type === 'viewer').length, 1);
});

test('link page: unsafe or unknown sources never load; not embeddable videos report a short error', async () => {
  const page = linkPage();
  page.send({type: 'source', source: {key: 'link:abcdefgh23456789:1', kind: 'mp4', url: 'http://cdn.example.test/a.mp4'}});
  assert.equal(page.posted.at(-1).status, 'error'); assert.equal(page.nodes.player.children.length, 0);
  page.send({type: 'source', source: {key: 'link:abcdefgh23456789:2', kind: 'youtube', videoId: '../evil'}}); await settle();
  assert.equal(page.players.length, 0); assert.equal(page.posted.at(-1).status, 'error');
  page.send({type: 'source', source: ytSource(4)}); await settle();
  page.players[0].events.onError({data: 150});
  assert.match(page.posted.at(-1).message, /keine Einbettung/);
});

test('WebView2 wiring: virtual HTTPS host for the link page only, pop-ups blocked, assets shipped, same origin everywhere', () => {
  const bridge = read(new URL('../../composeApp/src/desktopMain/native/windows/player_bridge.cpp', import.meta.url));
  const party = read(ui('party.js')), html = read(ui('link-player.html'));
  const assets = read(new URL('../../composeApp/src/desktopMain/kotlin/com/nuvio/app/features/player/desktop/NativePlayerBridge.kt', import.meta.url));
  assert.match(bridge, /NUVIO_LINK_HOST = L"nuvio-link\.example"/);
  assert.match(bridge, /SetVirtualHostNameToFolderMapping\(\s*NUVIO_LINK_HOST, folder\.c_str\(\), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS\)/);
  assert.match(bridge, /add_NewWindowRequested/); assert.match(bridge, /add_NavigationStarting/);
  assert.match(party, /PARTY_LINK_ORIGIN = "https:\/\/nuvio-link\.example"/);
  assert.match(party, /event\.origin !== PARTY_LINK_ORIGIN/);
  for (const name of ['link-player.html', 'link-player.js', 'link-policy.js']) assert.ok(assets.includes(`"${name}" to readResourceBytes("/player-ui/${name}")`), name);
  assert.match(html, /frame-src https:\/\/www\.youtube\.com\/embed\//);
  assert.match(html, /script-src 'self' https:\/\/www\.youtube\.com\/iframe_api https:\/\/www\.youtube\.com\/s\/player\//);
  assert.doesNotMatch(html, /unsafe-eval/);
});
