import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {classifyVideoLink} from '../src/smart-video-link.js';
import {YouTubePlayerAdapter} from '../src/youtube-player.js';

const id = 'M7lc1UVf-VE';

test('YouTube URL variants keep only a valid video ID', () => {
  for (const url of [
    `https://youtube.com/watch?v=${id}&list=ignored&t=42`,
    `https://www.youtube.com/watch?si=ignored&v=${id}`,
    `https://m.youtube.com/shorts/${id}`,
    `https://youtu.be/${id}?si=ignored`,
  ]) assert.deepEqual(classifyVideoLink(url), {kind: 'youtube', id});
  assert.deepEqual(classifyVideoLink(`https://youtube.com/live/${id}`), {kind: 'unsupported', reason: 'youtube_live'});
});

test('spoofed hosts, malformed or ambiguous IDs and unsafe origins do not become YouTube embeds', () => {
  for (const url of [
    `https://youtube.com.evil.test/watch?v=${id}`, `https://notyoutube.com/watch?v=${id}`,
    `https://evil.test@youtube.com/watch?v=${id}`, `https://youtube.com@evil.test/watch?v=${id}`,
    `https://www.youtube.com:444/watch?v=${id}`, `https://youtube.com/watch?v=${id}&v=${id}`,
    `https://youtu.be/${id}/extra`, 'https://youtube.com/watch?v=bad', `http://youtu.be/${id}`,
    'https://localhost./a.mp4', 'https://192.168.1.1/a.webm', 'https://nas.home.arpa/a.m3u8',
  ]) assert.equal(classifyVideoLink(url).kind, 'unsupported');
});

test('HLS, opaque TorBox, MP4 and WebM preserve signed media URLs', () => {
  for (const [kind, url] of [
    ['hls', 'https://media.example.test/master.M3U8?sig=synthetic'],
    ['hls', 'https://flux.wnam.tb-cdn.io/stream/p/42?token=synthetic'],
    ['mp4', 'https://media.example.test/clip.MP4?sig=synthetic'],
    ['webm', 'https://media.example.test/clip.webm'],
  ]) assert.deepEqual(classifyVideoLink(url), {kind, url});
  assert.deepEqual(classifyVideoLink('https://media.example.test/film.mpd'), {kind: 'unsupported'});
  assert.deepEqual(classifyVideoLink('https://cdn.example.test/opaque'), {kind: 'unsupported', hlsCandidate: 'https://cdn.example.test/opaque'});
});

function playerFixture(loadApi) {
  const status = [], players = [];
  const mount = {children: [], ownerDocument: {createElement: () => ({})}, replaceChildren(...children) { this.children = children; }};
  const api = {Player: class {
    constructor(frame, {events}) { this.frame = frame; this.events = events; this.calls = []; players.push(this); }
    playVideo() { this.calls.push('play'); }
    pauseVideo() { this.calls.push('pause'); }
    seekTo(seconds, ahead) { this.calls.push([seconds, ahead]); }
    getCurrentTime() { return 12; }
    getDuration() { return 60; }
    destroy() { this.destroyed = true; }
  }};
  const adapter = new YouTubePlayerAdapter(mount, {origin: 'https://watch.example.test',
    onStatus: message => status.push(message), loadApi: loadApi || (async () => api)});
  return {adapter, mount, api, status, players};
}

test('official iframe adapter keeps native controls and delegates playback and buffering', async t => {
  const {adapter, mount, players, status} = playerFixture();
  t.after(() => adapter.destroy());
  await adapter.open(id);
  const [p] = players, [frame] = mount.children;
  const embed = new URL(frame.src);
  assert.equal(embed.origin + embed.pathname, `https://www.youtube.com/embed/${id}`);
  assert.deepEqual(Object.fromEntries(embed.searchParams), {enablejsapi: '1', origin: 'https://watch.example.test', playsinline: '1'});
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(frame.allowFullscreen, true);
  assert.equal(adapter.position, null);
  p.events.onReady();
  assert.deepEqual(p.calls, []); // No autoplay on load.
  adapter.play(); adapter.pause(); adapter.seek(13); adapter.seek(-1);
  assert.deepEqual(p.calls, ['play', 'pause', [13, true]]);
  assert.equal(adapter.position, 12);
  assert.equal(adapter.duration, 60);
  p.events.onStateChange({data: 3}); assert.equal(adapter.buffering, true);
  p.events.onAutoplayBlocked(); assert.match(status.at(-1), /Start blockiert/);
  p.events.onError({data: 150}); assert.match(status.at(-1), /keine Einbettung/);
  assert.equal(p.destroyed, true); assert.deepEqual(mount.children, []);
  p.events.onStateChange({data: 1}); assert.match(status.at(-1), /keine Einbettung/);
});

test('an old API load or callback cannot open or update a newer source', async t => {
  let releaseFirst;
  const pending = new Promise(resolve => { releaseFirst = resolve; });
  let attempts = 0;
  const {adapter, api, players, mount, status} = playerFixture(() => ++attempts === 1 ? pending : Promise.resolve(api));
  t.after(() => adapter.destroy());
  const old = adapter.open(id);
  await adapter.open('dQw4w9WgXcQ');
  releaseFirst(api); await old;
  assert.equal(players.length, 1);
  assert.match(mount.children[0].src, /dQw4w9WgXcQ/);
  const [previous] = players;
  await adapter.open(id);
  assert.equal(previous.destroyed, true);
  previous.events.onError({data: 153});
  assert.doesNotMatch(status.at(-1), /identifizieren/);
  assert.match(mount.children[0].src, new RegExp(id));
});

test('invalid IDs never load the API, and loader failures show a safe error', async () => {
  let calls = 0;
  const {adapter, mount, status} = playerFixture(async () => { calls++; throw new Error('private test value'); });
  await assert.rejects(adapter.open('../invalid'));
  assert.equal(calls, 0);
  await adapter.open(id);
  assert.equal(calls, 1);
  assert.equal(mount.children.length, 0);
  assert.match(status.at(-1), /konnte nicht geladen werden/);
  assert.doesNotMatch(status.at(-1), /private test value/);
});
