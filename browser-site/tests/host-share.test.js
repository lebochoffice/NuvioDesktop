import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {classifyShareLink, familyHlsRequest, hostShareStream, proposalFrom, linkHost} from '../src/host-share.js';

test('only direct public HTTPS HLS, MP4 and WebM links can be shared', () => {
  assert.deepEqual(classifyShareLink(' https://cdn.example.test/film/master.m3u8?sig=abc '), {kind: 'hls', url: 'https://cdn.example.test/film/master.m3u8?sig=abc'});
  assert.equal(classifyShareLink('https://cdn.example.test/a.MP4').kind, 'mp4');
  assert.equal(classifyShareLink('https://cdn.example.test/a.webm').kind, 'webm');
  for (const bad of ['', 'http://cdn.example.test/a.mp4', 'https://localhost/a.mp4', 'https://192.168.1.4/a.mp4', 'https://10.0.0.2/a.m3u8',
    'https://user:pw@cdn.example.test/a.mp4', 'https://cdn.example.test/a.mp4#t=3', 'https://cdn.example.test/a.mkv',
    'https://cdn.example.test/a.m3u8?token=account', 'https://torbox.app/a.m3u8',
    'https://cdn.example.test/manifest.mpd', 'https://www.youtube.com/watch?v=M7lc1UVf-VE', 'https://cdn.example.test/page',
    'magnet:?xt=urn:btih:abc', 'https://cdn.example.test/a b.mp4', `https://cdn.example.test/${'x'.repeat(5000)}.mp4`]) {
    assert.ok(classifyShareLink(bad).problem, bad);
  }
});

test('the shared link is an ordinary host stream offer for the party title, without headers', () => {
  const {stream, kind} = hostShareStream('https://cdn.example.test/a.mp4', 'movie|tt1||');
  assert.equal(kind, 'mp4');
  assert.deepEqual(stream, {media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4', name: 'Video-Link des Hosts', stream_type: 'mp4', headers: {}, response_headers: {}});
  assert.equal(hostShareStream('https://cdn.example.test/a.m3u8', 'movie|tt1||').stream.stream_type, 'hls');
  assert.ok(hostShareStream('https://cdn.example.test/a.mp4', '').problem);
  assert.ok(hostShareStream('http://cdn.example.test/a.mp4', 'movie|tt1||').problem);
});

test('family HLS keeps its synthetic token only on requests to the exact playlist origin', () => {
  const source = 'https://media.tb-cdn.io/path/master.m3u8?token=SYNTHETIC_MEDIA_TOKEN';
  assert.ok(classifyShareLink(source).problem);
  const {stream} = hostShareStream(source, 'movie|tt1||', true);
  assert.equal(stream.url, '');
  assert.equal(stream.browser_hls.url, undefined);
  assert.equal(stream.browser_hls.family_beta_url, source);
  const request = familyHlsRequest(source, 'seg.ts', {headers: {Range: 'bytes=0-1023'}});
  assert.equal(request.url, 'https://media.tb-cdn.io/path/seg.ts?token=SYNTHETIC_MEDIA_TOKEN');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.headers.get('range'), 'bytes=0-1023');
  for (const target of ['https://other.tb-cdn.io/seg.ts', 'https://example.test/seg.ts', 'http://media.tb-cdn.io/seg.ts'])
    assert.throws(() => familyHlsRequest(source, target), /andere Medienadresse/);
  assert.ok(classifyShareLink('https://api.torbox.app/path/master.m3u8?token=SYNTHETIC', true).problem);
  assert.ok(classifyShareLink('https://media.tb-cdn.io/path/video.mp4?token=SYNTHETIC', true).problem);
});

test('proposals count only from current members for the current title; the name is display only', () => {
  const room = {memberId: 'host', members: [{id: 'host', display_name: 'Host'}, {id: 'guest', display_name: 'Gast\u0000 Anna'}]};
  const ok = proposalFrom({member_id: 'guest', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.webm?sig=t'}, room, 'movie|tt1||');
  assert.deepEqual(ok, {memberId: 'guest', name: 'Gast Anna', url: 'https://cdn.example.test/a.webm?sig=t', kind: 'webm', host: 'cdn.example.test'});
  for (const payload of [
    {member_id: 'stranger', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'}, // Not a member in the server snapshot.
    {member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'},     // The host itself.
    {member_id: 'guest', media_key: 'movie|tt2||', url: 'https://cdn.example.test/a.mp4'},    // Other title.
    {member_id: 'guest', media_key: 'movie|tt1||', url: 'https://localhost/a.mp4'},           // Unsafe target.
    {member_id: 'guest', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mkv'},
    null, 'x',
  ]) assert.equal(proposalFrom(payload, room, 'movie|tt1||'), null, JSON.stringify(payload));
  assert.equal(linkHost('https://CDN.Example.test/x.mp4?token=secret'), 'cdn.example.test'); // Never the token.
});
