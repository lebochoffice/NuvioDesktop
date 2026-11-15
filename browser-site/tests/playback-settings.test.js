import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};

test('the gear contains subtitles and reuses track selection and local file loading', async () => {
  assert.match(html, /id="playbackSettings"[\s\S]*id="quality"[\s\S]*id="audioTrack"[\s\S]*id="subtitleOptions"[\s\S]*id="subtitleFile"[\s\S]*id="openPartySettings"/);
  assert.doesNotMatch(html, /id="ctlSubtitles"/);
  const make = () => ({
    handlers: {},
    setAttribute() {},
    addEventListener(event, handler) { this.handlers[event] = handler; },
    replaceChildren(...children) { this.children = children; },
    click() { this.clicked = true; },
  });
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, make());
    return nodes.get(id);
  };
  const hls = {subtitleTracks: [{lang: 'de'}], subtitleTrack: -1, subtitleDisplay: false};
  const player = {textTracks: [], append(element) { this.textTracks.push(element.track); }};
  const context = createContext({
    $: byId,
    document: {createElement: tag => ({...make(), ...(tag === 'track' ? {track: {kind: 'subtitles'}} : {})})},
    currentHls: () => hls, player, status() {}, URL, Blob,
  });
  runInContext(between('let subtitleFiles =', "  addSubtitleFile(file);") + '  addSubtitleFile(file);\n});', context);
  byId('subtitleOptions').open = true;
  byId('subtitleOptions').handlers.toggle();
  const menu = byId('subtitleMenu');
  menu.children[2].handlers.click();
  assert.equal(hls.subtitleTrack, 0);
  menu.children[1].handlers.click();
  assert.equal(hls.subtitleTrack, -1);
  menu.children.at(-1).handlers.click();
  assert.equal(byId('subtitleFile').clicked, true);
  const addSubtitleFile = runInContext('addSubtitleFile', context);
  await addSubtitleFile({name: 'demo.srt', size: 64, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nExample'});
  assert.equal(player.textTracks.at(-1).mode, 'showing');
  assert.equal(menu.children.at(-2).textContent, 'demo');
});

test('known German is labelled, and unknown or fixed media exposes no extra alternatives', () => {
  const context = createContext({});
  const label = runInContext(between('function audioLanguage(', 'function audioTracks(') + 'audioTrackLabel', context);
  assert.equal(label({lang: 'de-DE'}, 0, 1), 'Deutsch');
  assert.equal(label({}, 0, 1), 'Audio · 1 Spur');
  assert.match(source, /Audio · festgelegt/);
  assert.match(source, /variants\.length === 1 \? \[new Option\(variants\[0\]\.label \+ ' · festgelegt'/);
});
