import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {normalizeCode,partyCodeFromPath,validCode,mediaKey,expectedPositionMs,safeStreamUrl,isNewerPlayback,validPlayback,streamProblem,streamIsHls,browserPartyStream,publicConfigProblem,memberSync,memberSyncLabel,formatDrift} from '../src/protocol.js';
test('normalize URL party code',()=>{assert.equal(normalizeCode('uxz-83h'),'UXZ83H');assert.ok(validCode('UXZ 83H'));assert.equal(partyCodeFromPath('/party/UXZ83H'),'UXZ83H');assert.equal(partyCodeFromPath('/party/abcd'),'');});
test('media key same as desktop contract',()=>{assert.equal(mediaKey({meta_type:'Movie',meta_id:'tt123',season:null,episode:null}),'movie|tt123||');assert.equal(mediaKey({meta_type:'Movie',meta_id:'TT123'}),'movie|TT123||');});
test('expected playback position accounts for pauses and clock',()=>{assert.equal(expectedPositionMs({paused:false,waiting:false,position_ms:120000,rate:1,at:1000},3500),122500);assert.equal(expectedPositionMs({paused:true,position_ms:120000,rate:1,at:1000},3500),120000);});
test('remote stream URLs disallow local and credentials',()=>{assert.ok(safeStreamUrl('https://cdn.example.org/vid.m3u8'));assert.ok(!safeStreamUrl('http://127.0.0.1/foo.mp4'));assert.ok(!safeStreamUrl('http://192.168.1.3/'));assert.ok(!safeStreamUrl('https://user:pw@example.com/v.mp4'));assert.ok(!safeStreamUrl('magnet:?xt=hello'));});

test('codes cannot silently discard invalid characters or truncate a different invite', () => {
  for (const code of ['UXZ83HXX', '0UXZ83H', 'UXZ/83H', 'UXZ83H?token=secret']) assert.equal(validCode(code), false);
  assert.equal(partyCodeFromPath('/party/UXZ83HXX'), '');
  assert.equal(partyCodeFromPath('/party/%ZZ'), '');
});
test('sequence ties and non-finite state follow desktop acceptance contract', () => {
  assert.ok(isNewerPlayback({seq: 3, member_id: 'b'}, {seq: 3, member_id: 'a'}));
  assert.ok(!isNewerPlayback({seq: 3, member_id: 'a'}, {seq: 3, member_id: 'b'}));
  assert.ok(!validPlayback({seq: 1, paused: false, at: NaN, position_ms: 0}));
  assert.ok(!validPlayback({seq: 1, paused: false, at: 0, position_ms: -1}));
  assert.equal(expectedPositionMs({paused: false, position_ms: 1, at: 0, rate: .25}, 10), 3);
});
test('unsafe/mixed-content addresses are refused including alternate IP spellings', () => {
  for (const url of ['http://cdn.example.org/v.mp4','https://127.1/v','https://2130706433/v','https://[::ffff:127.0.0.1]/v','https://[fc00::1]/v','https://x.localhost/v','https://100.64.0.1/v']) assert.equal(safeStreamUrl(url), false, url);
  assert.ok(safeStreamUrl('https://[2606:4700::1111]/v'));
});
test('header-dependent, response rewriting, disguised MKV and unsupported streams are explicit errors', () => {
  const base = {url: 'https://cdn.example.org/video'};
  assert.match(streamProblem({...base, headers: {Authorization: 'secret'}}), /HTTP-Header/);
  assert.match(streamProblem({...base, response_headers: {'Access-Control-Allow-Origin': '*'}}), /Antwort-Headern/);
  assert.match(streamProblem({...base, filename: 'film.mkv'}), /MKV/);
  assert.match(streamProblem({...base, url: base.url + '.mpd'}), /DASH/);
  assert.equal(streamProblem(base), ''); // Extensionless sources are tried; codecs cannot be inferred.
  assert.ok(streamIsHls({...base, stream_type: 'application/x-mpegURL'}));
});
test('only public backend configuration is accepted', () => {
  const jwt = role => 'e30.' + Buffer.from(JSON.stringify({role})).toString('base64url') + '.signature';
  assert.equal(publicConfigProblem('https://api.example.org', jwt('anon')), '');
  assert.equal(publicConfigProblem('https://api.example.org', 'sb_publishable_example'), '');
  for (const key of [jwt('service_role'), 'sb_secret_example', 'personal-token']) assert.match(publicConfigProblem('https://api.example.org', key), /Key/);
  assert.ok(publicConfigProblem('', ''));
  assert.ok(publicConfigProblem('https://api.example.org/path', jwt('anon')));
});

test('HLS permits safe request headers without enabling credential or response header rewriting', () => {
  const stream = {url: 'https://stream.example.test/v', stream_type: 'hls', headers: {Accept: 'application/vnd.apple.mpegurl', 'Accept-Language': 'de'}};
  assert.equal(streamProblem(stream), '');
  assert.match(streamProblem({...stream, headers: {Referer: 'https://example.test'}}), /HTTP-Header/);
  assert.match(streamProblem({...stream, headers: {Accept: 'video\r\nInjected: yes'}}), /HTTP-Header/);
  assert.match(streamProblem({...stream, stream_type: 'mp4'}), /HTTP-Header/);
});

test('browser selection leaves the Desktop original intact and inherits its media key only', () => {
  const original = {media_key: 'movie|tt1||', url: 'https://desktop.example.test/film.mkv', filename: 'film.mkv',
    headers: {Referer: 'https://provider.example.test'}, video_size: 1000000, stream_type: 'mkv',
    browser_hls: {url: 'https://stream.example.test/master.m3u8', headers: {Accept: 'application/vnd.apple.mpegurl'}}};
  const before = JSON.stringify(original), browser = browserPartyStream(original);
  assert.equal(browser.url, original.browser_hls.url); assert.equal(browser.media_key, original.media_key);
  assert.equal(streamProblem(browser), ''); assert.equal(browser.stream_type, 'hls');
  assert.equal(browser.filename, undefined); assert.equal(browser.headers.Referer, undefined);
  assert.equal(JSON.stringify(original), before);
  for (const browser_hls of [{}, {url: null}, null, []]) assert.equal(browserPartyStream({...original, browser_hls}), null);
  assert.equal(browserPartyStream(null), null);
  const legacy = {media_key: original.media_key, url: 'https://desktop.example.test/video.mp4'};
  assert.equal(browserPartyStream(legacy), legacy);
});

// Member sync display (same rule as Desktop PartySync.memberSync). Written, not executed here.
test('member sync: synced, catching up, buffering, unsynced (behind), stale and other film', () => {
  const party = {seq: 3, member_id: 'host', paused: false, position_ms: 60000, rate: 1, at: 10000};
  const r = extra => ({status: 'ready', media_key: 'movie|tt1||', position_ms: 60000, position_at: 10000, playing: true, ...extra});
  assert.deepEqual(memberSync(r({}), party, 'movie|tt1||', 15000), {state: 'synced', positionMs: 65000, driftMs: 0});
  assert.equal(memberSync(r({position_ms: 56000}), party, 'movie|tt1||', 15000).state, 'catching_up');
  assert.equal(memberSync(r({position_ms: 56000}), party, 'movie|tt1||', 15000).driftMs, -4000);
  assert.equal(memberSync(r({position_ms: 20000}), party, 'movie|tt1||', 15000).state, 'unsynced');
  assert.equal(memberSync(r({status: 'buffering'}), party, 'movie|tt1||', 15000).state, 'buffering');
  assert.equal(memberSync(r({status: 'behind'}), party, 'movie|tt1||', 15000).state, 'unsynced');
  assert.equal(memberSync(r({}), party, 'movie|tt1||', 10000 + 30001).state, 'stale');
  assert.equal(memberSync(r({media_key: 'movie|tt9||'}), party, 'movie|tt1||', 15000).state, 'unknown');
  assert.equal(memberSync({status: 'ready'}, party, 'movie|tt1||', 15000).state, 'unknown'); // Old client: no position.
  assert.equal(memberSync({status: 'behind'}, party, 'movie|tt1||', 15000).state, 'unsynced');
  assert.equal(memberSync(r({playing: false}), {...party, paused: true}, 'movie|tt1||', 15000).state, 'synced');
});
test('member sync labels and drift formatting', () => {
  assert.equal(formatDrift(0), '+0,0 s'); assert.equal(formatDrift(-4249), '−4,2 s'); assert.equal(formatDrift(65400), '+1:05');
  assert.equal(memberSyncLabel({state: 'synced', driftMs: 300}), 'Synchron (+0,3 s)');
  assert.equal(memberSyncLabel({state: 'catching_up', driftMs: -4000}), 'Holt auf (−4,0 s)');
  assert.equal(memberSyncLabel({state: 'buffering'}), 'Puffert'); assert.equal(memberSyncLabel({state: 'stale'}), 'Status veraltet');
  assert.equal(memberSyncLabel({state: 'unsynced', driftMs: -90000}), 'Unsynchron (−1:30)'); assert.equal(memberSyncLabel({state: 'unknown'}), '');
});

test('browser_hls label names a host video link; control characters are stripped and it never changes the transport', () => {
  const stream = {media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.m3u8', browser_hls: {url: 'https://cdn.example.test/a.m3u8', label: 'Video-Link\u0000 des Hosts'}};
  assert.equal(browserPartyStream(stream).name, 'Video-Link des Hosts');
  assert.equal(browserPartyStream({...stream, browser_hls: {url: stream.url}}).name, 'TorBox HLS');
  assert.equal(browserPartyStream({...stream, browser_hls: {url: stream.url, label: 'x'.repeat(200)}}).name.length, 80);
});
