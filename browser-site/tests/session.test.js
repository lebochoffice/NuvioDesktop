import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {PartySession} from '../src/session.js';

const media = {meta_type: 'movie', meta_id: 'tt1', title: 'Example'};
const playback = {seq: 2, member_id: 'host', paused: false, position_ms: 1000, rate: 1, at: 1000, media_key: 'movie|tt1||'};
const snapshot = () => ({party: {id: 'room-1', code: 'UXZ83H', media, host_member_id: 'host', host_only: true, playback}, member_id: 'guest', members: [{id:'host', display_name:'Host'},{id:'guest', display_name:'Guest'}]});
function fixture(handlers = {}) {
  const calls = [], messages = [], events = [], tracks = [];
  let cb;
  const ch = {on(_type, {event}, callback) { events.push({event, callback}); return this; }, subscribe(callback) { cb = callback; }, track: async p => {tracks.push(p); return 'ok';}, send: async p => {messages.push(p); return 'ok';}};
  const client = {
    auth: {getSession: async () => ({data: {session: {access_token: 'session-jwt', user: {id: 'u', is_anonymous: false}}}})},
    realtime: {setAuth: async token => calls.push(['auth', token])},
    channel: (name, options) => { calls.push(['channel', name, options]); return ch; },
    removeChannel: async () => calls.push(['remove']),
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'watch_party_clock') return {data: Date.now()};
      if (name === 'watch_party_list_messages') return {data: {messages: []}};
      return {data: snapshot()};
    },
  };
  return {client, calls, messages, tracks, ch, connect: () => cb('SUBSCRIBED'), emit: (event, payload) => events.find(e => e.event === event).callback({payload}), session: new PartySession(client, 'device', handlers)};
}
test('authenticated private channel, state request, browsing presence and cleanup', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  const channel = f.calls.find(c => c[0] === 'channel');
  assert.equal(channel[1], 'watch-party:room-1');
  assert.equal(channel[2].config.private, true);
  assert.ok(f.calls.findIndex(c => c[0] === 'auth') < f.calls.findIndex(c => c[0] === 'channel'));
  assert.equal(f.tracks[0].status, 'browsing');
  assert.equal(f.tracks[0].media_key, 'movie|tt1||');
  assert.ok(f.messages.some(m => m.event === 'state_request' && m.payload.member_id === 'guest'));
  await f.session.sendPresence('ready'); assert.equal(f.tracks.at(-1).status, 'ready');
  await f.session.sendPresence('behind', 5000); assert.equal(f.tracks.at(-1).behind_ms, 5000);
  await f.session.close();
  assert.equal(f.session.room, null); assert.equal(f.session.timers.length, 0);
  assert.ok(f.calls.some(c => c[0] === 'watch_party_leave'));
});
test('join profile fallback only on the missing RPC signature', async t => {
  const f = fixture(); t.after(() => f.session.close());
  const rpc = f.client.rpc;
  f.client.rpc = async (name, args) => name === 'watch_party_join' && args.p_profile_index != null ? {error: {code: 'PGRST202'}} : rpc(name, args);
  await f.session.join('UXZ83H', 'Guest', 0);
  assert.ok(f.session.room);
  assert.ok(!('p_profile_index' in f.calls.find(c => c[0] === 'watch_party_join')[1]));
  await f.session.close();
  f.client.rpc = async () => ({error: {code: '42501'}});
  await assert.rejects(f.session.join('UXZ83H', 'Guest', 0), e => e.code === '42501');
});
test('anonymous users cannot join and no RPC is called', async () => {
  const f = fixture();
  f.client.auth.getSession = async () => ({data: {session: {user: {is_anonymous: true}}}});
  await assert.rejects(f.session.join('UXZ83H', 'Guest'), /nicht anonymes/);
  assert.equal(f.calls.length, 0);
});
test('playback checks host, media and equal sequence tie-break; untrusted streams ignored', async t => {
  const streams = [], f = fixture({stream: s => streams.push(s)}); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  f.emit('state', {...playback, seq: 99, member_id: 'guest'}); assert.equal(f.session.playback.seq, 2);
  f.emit('state', {...playback, seq: 99, media_key: 'other'}); assert.equal(f.session.playback.seq, 2);
  f.emit('stream', {member_id: 'guest', stream: {url: 'bad'}}); assert.equal(streams.length, 0);
  f.emit('stream', {member_id: 'host', stream: null}); assert.deepEqual(streams, [null]);
  f.session.room.info.host_only = false;
  f.emit('state', {...playback, member_id: 'z'}); assert.equal(f.session.playback.member_id, 'z');
  f.emit('state', {...playback, member_id: 'a'}); assert.equal(f.session.playback.member_id, 'z');
});
test('snapshot media changes reset ordering and revoke the previous stream', async t => {
  const streams = [], f = fixture({stream: s => streams.push(s)}); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  f.client.rpc = async () => ({data: {...snapshot(), party: {...snapshot().party, media: {...media, meta_id: 'tt2'}, playback: {...playback, seq: 0, media_key:'movie|tt2||'}}}});
  await f.session.refresh();
  assert.equal(f.session.playback.seq, 0); assert.deepEqual(streams, [null]);
  assert.ok(f.messages.some(m => m.event === 'state_request'));
});
test('stale heartbeat and old channel events cannot resurrect a closed room', async () => {
  const f = fixture(); await f.session.join('UXZ83H', 'Guest');
  let resolve;
  f.client.rpc = async () => new Promise(r => { resolve = r; });
  const refresh = f.session.refresh();
  await f.session.close(false);
  resolve({data: snapshot()}); await refresh;
  f.emit('state', {...playback, seq: 99});
  assert.equal(f.session.room, null); assert.equal(f.session.playback, null);
});
test('chat RPC cursor, duplicate handling and send identity match desktop', async t => {
  const chat = [], f = fixture({chat: m => chat.push(m)}); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  const rpc = f.client.rpc;
  f.client.rpc = async (name, args) => {
    if (name === 'watch_party_list_messages') { f.calls.push([name, args]); return {data: {messages: [{id: '9', body: 'hello'}, {id: '10', body: '<script>'}]}}; }
    return rpc(name, args);
  };
  await f.session.loadMessages(); await f.session.loadMessages();
  assert.equal(chat.length, 2); assert.equal(f.session.chatCursor, '10');
  assert.equal(f.calls.at(-1)[1].p_after, '10');
  await f.session.sendMessage('reply', 'stable-client-id');
  assert.deepEqual(f.calls.find(c => c[0] === 'watch_party_send_message')[1], {p_party_id: 'room-1', p_device_id: 'device', p_body:'reply', p_client_id:'stable-client-id'});
});
test('removed membership closes video/session and cancels periodic work', async () => {
  const ended = [], f = fixture({ended: m => ended.push(m)});
  await f.session.join('UXZ83H', 'Guest');
  f.client.rpc = async () => ({data: {error:'removed'}});
  await f.session.refresh();
  assert.equal(f.session.room, null); assert.equal(f.session.timers.length, 0); assert.equal(ended.length, 1);
});

test('presence failures are reported without suppressing the independent stream request', async t => {
  const errors = [], f = fixture({error: e => errors.push(e.message)}); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  f.ch.track = async () => 'timed out';
  await f.connect();
  assert.ok(errors.some(e => e.includes('Online-Status nicht bestätigt')));
  assert.ok(f.messages.some(m => m.event === 'state_request'));
});
