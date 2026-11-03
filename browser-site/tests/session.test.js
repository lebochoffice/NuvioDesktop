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

test('a replacement host can restart sequence ordering without a media reset', async t => {
  const mediaEvents = [], f = fixture({media: media => mediaEvents.push(media)});
  t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Guest');
  const rpc = f.client.rpc;
  f.client.rpc = async (name, args) => name === 'watch_party_heartbeat'
    ? {data: {...snapshot(), party: {...snapshot().party, host_member_id: 'new-host', playback: {...playback, seq: 0, member_id: 'new-host'}}}}
    : rpc(name, args);
  await f.session.refresh();
  assert.equal(f.session.playback.member_id, 'new-host'); assert.equal(f.session.playback.seq, 0);
  assert.deepEqual(mediaEvents, []);
  f.emit('state', {...playback, seq: 999}); assert.equal(f.session.playback.member_id, 'new-host');
});

test('party-ended snapshot closes membership before any later playback can be accepted', async () => {
  const events = [], f = fixture({closed: () => events.push('closed'), ended: () => events.push('ended')});
  await f.session.join('UXZ83H', 'Guest');
  f.client.rpc = async () => ({data: {party: null}});
  await f.session.refresh();
  assert.equal(f.session.room, null); assert.equal(f.session.playback, null);
  assert.deepEqual(events, ['closed', 'ended']);
  f.emit('state', {...playback, seq: 999}); assert.equal(f.session.playback, null);
});

test('empty and repeated closes do not emit lifecycle events; concurrent closes share cleanup', async () => {
  const events = [], f = fixture({closed: () => events.push('closed')});
  await f.session.close(false); await f.session.close(false);
  assert.deepEqual(events, []);
  await f.session.join('UXZ83H', 'Guest'); assert.deepEqual(events, []);
  let releaseRemoval, startedRemoval, removals = 0;
  const removal = new Promise(resolve => {releaseRemoval = resolve;});
  const started = new Promise(resolve => {startedRemoval = resolve;});
  f.client.removeChannel = () => {removals++; startedRemoval(); return removal;};
  const first = f.session.close(), second = f.session.close();
  assert.equal(first, second);
  assert.equal(f.session.room, null); assert.equal(f.session.playback, null);
  assert.equal(f.session.timers.length, 0); assert.deepEqual(events, ['closed']);
  f.emit('state', {...playback, seq: 999}); assert.equal(f.session.playback, null);
  await started; assert.equal(removals, 1);
  let settled = false; second.then(() => {settled = true;});
  await Promise.resolve(); assert.equal(settled, false);
  releaseRemoval(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(([name]) => name === 'watch_party_leave').length, 1);
  await f.session.close(); assert.deepEqual(events, ['closed']);
});

test('concurrent finish calls emit closed and ended once after cleanup', async () => {
  const events = [], f = fixture({closed: () => events.push('closed'), ended: () => events.push('ended')});
  await f.session.join('UXZ83H', 'Guest');
  let releaseRemoval;
  f.client.removeChannel = () => new Promise(resolve => {releaseRemoval = resolve;});
  const first = f.session.finish('Ended'), second = f.session.finish('Ended');
  assert.deepEqual(events, ['closed']);
  await Promise.resolve(); // Enter the deferred channel cleanup.
  releaseRemoval(); await Promise.all([first, second]);
  await f.session.finish('Ended'); assert.deepEqual(events, ['closed', 'ended']);
  f.emit('state', {...playback, seq: 999}); assert.equal(f.session.playback, null);
});

test('a new join supersedes an old ended callback while channel cleanup is pending', async t => {
  const events = [], f = fixture({closed: () => events.push('closed'), ended: () => events.push('ended')});
  t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Guest');
  let releaseRemoval;
  f.client.removeChannel = () => new Promise(resolve => {releaseRemoval = resolve;});
  const finish = f.session.finish('Old party ended');
  const join = f.session.join('UXZ83H', 'Guest');
  await Promise.resolve(); releaseRemoval();
  await Promise.all([finish, join]);
  assert.ok(f.session.room); assert.deepEqual(events, ['closed']);
  // Keep teardown independent of the already released deferred operation.
  f.client.removeChannel = async () => {};
});

test('closing an empty session still invalidates an in-flight join', async () => {
  const events = [], f = fixture({closed: () => events.push('closed')});
  let authorize, authStarted;
  const started = new Promise(resolve => {authStarted = resolve;});
  f.client.auth.getSession = () => { authStarted(); return new Promise(resolve => {authorize = resolve;}); };
  const joining = f.session.join('UXZ83H', 'Guest');
  await started; await f.session.close(false);
  authorize({data: {session: {access_token: 'session-jwt', user: {id: 'u', is_anonymous: false}}}});
  await joining;
  assert.equal(f.session.room, null); assert.equal(f.calls.length, 0); assert.deepEqual(events, []);
});

test('state broadcasts are accepted immediately and a delayed older heartbeat cannot re-pause playback', async t => {
  const changes = [], f = fixture({playback: state => changes.push(state)});
  t.after(() => f.session.close(false)); await f.session.join('UXZ83H', 'Guest');
  const rpc = f.client.rpc; let resolveHeartbeat;
  f.client.rpc = (name, args) => name === 'watch_party_heartbeat'
    ? new Promise(resolve => {resolveHeartbeat = resolve;}) : rpc(name, args);
  const refresh = f.session.refresh();
  f.emit('state', {...playback, seq: 4, paused: false, position_ms: 12000});
  assert.equal(f.session.playback.seq, 4); assert.equal(f.session.playback.paused, false);
  assert.equal(f.session.diagnostics.acceptedSource, 'realtime');
  resolveHeartbeat({data: {...snapshot(), party: {...snapshot().party, playback: {...playback, seq: 3, paused: true}}}});
  await refresh;
  assert.equal(f.session.playback.seq, 4); assert.equal(f.session.playback.paused, false);
  assert.equal(changes.length, 2); // Initial snapshot and accepted state; no stale pause callback.
  assert.equal(f.session.diagnostics.lastSource, 'snapshot');
  assert.equal(f.session.diagnostics.lastDecision, 'not_newer');
  assert.equal(f.session.diagnostics.acceptedSource, 'realtime');
  f.emit('state', {...playback, seq: 5, paused: true});
  assert.equal(f.session.playback.paused, true); assert.equal(changes.length, 3);
});

test('state rejection diagnostics distinguish validation, media, authority and ordering without payload disclosure', async t => {
  const f = fixture(); t.after(() => f.session.close(false)); await f.session.join('UXZ83H', 'Guest');
  const secret = 'PRIVATE_STATE_SENTINEL';
  for (const [candidate, decision] of [
    [{...playback, seq: '3'}, 'invalid_playback'],
    [{...playback, seq: 3, media_key: secret}, 'wrong_media'],
    [{...playback, seq: 3, member_id: secret}, 'not_host'],
    [{...playback, seq: 1}, 'not_newer'],
    [null, 'invalid_playback'],
  ]) {
    f.emit('state', candidate && {...candidate, url: secret, token: secret});
    assert.equal(f.session.diagnostics.lastDecision, decision);
    assert.equal(f.session.playback.seq, 2);
    assert.ok(!JSON.stringify(f.session.diagnostics).includes(secret));
  }
  assert.equal(f.session.diagnostics.realtimeStates, 5);
  assert.equal(typeof f.session.diagnostics.lastRealtimeAt, 'number');
});

test('a newer snapshot remains a fallback; later stale realtime cannot roll it back', async t => {
  const f = fixture(); t.after(() => f.session.close(false)); await f.session.join('UXZ83H', 'Guest');
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => name === 'watch_party_heartbeat'
    ? Promise.resolve({data: {...snapshot(), party: {...snapshot().party, playback: {...playback, seq: 5, paused: true}}}})
    : rpc(name, args);
  await f.session.refresh();
  assert.equal(f.session.playback.paused, true); assert.equal(f.session.diagnostics.acceptedSource, 'snapshot');
  f.emit('state', {...playback, seq: 4, paused: false});
  assert.equal(f.session.playback.seq, 5); assert.equal(f.session.playback.paused, true);
  assert.equal(f.session.diagnostics.lastDecision, 'not_newer');
});

test('guest control requires an authoritative host_only=false snapshot, membership and a channel', async t => {
  const f = fixture(); t.after(() => f.session.close());
  assert.equal(f.session.canControl(), false); // No room.
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  assert.equal(f.session.canControl(), false); // Fixture snapshot: host_only=true.
  f.session.room.info.host_only = false; assert.equal(f.session.canControl(), true);
  f.session.room.info.host_only = true;
  assert.equal(f.session.canControl(), false);
  assert.throws(() => f.session.prepareControl({paused: true, positionMs: 1000}), e => e.code === 'host_only');
  // A broadcast cannot grant control: only DB snapshots change host_only.
  f.emit('control', {host_only: false});
  assert.equal(f.session.room.info.host_only, true);
  assert.ok(!f.calls.some(c => c[0] === 'watch_party_update'));
});

test('a guest command is persisted via watch_party_update first and broadcast only as the server-confirmed state', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.room.info.host_only = false;
  const rpc = f.client.rpc;
  f.client.rpc = async (name, args) => name === 'watch_party_update'
    ? (f.calls.push([name, args]), {data: {party: {...snapshot().party, host_only: false, playback: {...args.p_playback, at: 5000}}}})
    : rpc(name, args);
  const command = f.session.prepareControl({paused: true, positionMs: 61234.4});
  assert.deepEqual([command.playback.seq, command.playback.member_id, command.playback.position_ms, command.playback.waiting], [3, 'guest', 61234, false]);
  const before = f.messages.length;
  const stored = await f.session.commitControl(command);
  const update = f.calls.find(c => c[0] === 'watch_party_update');
  assert.equal(update[1].p_party_id, 'room-1'); assert.equal(update[1].p_device_id, 'device');
  assert.equal(update[1].p_playback.media_key, 'movie|tt1||');
  const broadcast = f.messages.slice(before).find(m => m.event === 'state');
  assert.equal(broadcast.payload, stored); assert.equal(broadcast.payload.at, 5000); // Server-normalised value, not ours.
  assert.equal(f.session.playback, stored); assert.equal(f.session.diagnostics.acceptedSource, 'command');
});

test('rejected, stale or foreign server results are never broadcast', async t => {
  for (const reply of [
    args => ({error: 'forbidden'}),
    args => ({party: {...snapshot().party, host_only: false, playback: null}}), // No stored playback.
    args => ({party: {...snapshot().party, host_only: false, playback: {...args.p_playback, member_id: 'host'}}}),
    args => ({party: {...snapshot().party, host_only: false, playback: {...args.p_playback, seq: 99}}}),
    args => ({party: {...snapshot().party, host_only: false, media: {meta_type: 'movie', meta_id: 'tt2'}, playback: args.p_playback}}),
  ]) {
    const f = fixture(); t.after(() => f.session.close());
    await f.session.join('UXZ83H', 'Guest'); await f.connect();
    f.session.room.info.host_only = false;
    const rpc = f.client.rpc;
    f.client.rpc = async (name, args) => name === 'watch_party_update' ? {data: reply(args)} : rpc(name, args);
    const before = f.messages.length;
    await assert.rejects(f.session.commitControl(f.session.prepareControl({paused: true, positionMs: 0})));
    assert.ok(!f.messages.slice(before).some(m => m.event === 'state'));
    assert.equal(f.session.playback.seq, 2);
  }
});

test('realtime latency is measured in server time and bounded', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.now = () => 10400;
  f.emit('state', {...playback, seq: 3, at: 10000}); assert.equal(f.session.diagnostics.realtimeLatencyMs, 400);
  f.emit('state', {...playback, seq: 4, at: -1e9}); assert.equal(f.session.diagnostics.realtimeLatencyMs, null);
});

test('anonymous Supabase identities may join only when the build explicitly allows it; the server still decides', async t => {
  const f = fixture(); t.after(() => f.session.close());
  f.client.auth.getSession = async () => ({data: {session: {access_token: 'anon-jwt', user: {id: 'anon', is_anonymous: true}}}});
  await assert.rejects(f.session.join('UXZ83H', 'Gast'), /nicht anonymes/);
  assert.ok(!f.calls.some(c => c[0] === 'watch_party_join'));
  await f.session.join('UXZ83H', 'Gast', null, {allowAnonymous: true});
  const join = f.calls.find(c => c[0] === 'watch_party_join');
  assert.equal(join[1].p_display_name, 'Gast'); assert.ok(!('p_member_id' in join[1])); // Identity comes from the JWT.
  const rejecting = fixture(); t.after(() => rejecting.session.close());
  rejecting.client.auth.getSession = f.client.auth.getSession;
  rejecting.client.rpc = async name => name === 'watch_party_join' ? {error: {code: '42501', message: 'permission denied'}} : {data: {}};
  await assert.rejects(rejecting.session.join('UXZ83H', 'Gast', null, {allowAnonymous: true}), e => e.code === '42501');
  assert.equal(rejecting.session.room, null);
});

test('desktop-parity mode broadcasts the command first (like Nuvio Desktop guests), then persists it with normal ordering', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.room.info.host_only = false;
  const order = [], send = f.ch.send, rpc = f.client.rpc;
  f.ch.send = async message => { order.push(['send', message.event]); return send(message); };
  f.client.rpc = async (name, args) => { order.push(['rpc', name]); return name === 'watch_party_update'
    ? {data: {party: {...snapshot().party, host_only: false, playback: {...playback, seq: 1}}}} : rpc(name, args); };
  const stored = await f.session.commitControl(f.session.prepareControl({paused: true, positionMs: 7000}), {mode: 'desktop'});
  assert.deepEqual(order, [['send', 'state'], ['rpc', 'watch_party_update']]);
  assert.equal(f.session.playback, stored); assert.equal(stored.seq, 3); assert.equal(stored.member_id, 'guest');
  assert.equal(f.session.diagnostics.lastCommandResult, 'broadcast'); // Returns before the RPC finished.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.diagnostics.lastCommandResult, 'persisted');
  f.ch.send = async () => 'rate limited';
  await assert.rejects(f.session.commitControl(f.session.prepareControl({paused: false, positionMs: 0}), {mode: 'desktop'}), e => e.code === 'broadcast_failed');
  assert.equal(f.session.playback, stored); // Nothing applied without a broadcast.
  f.session.room.info.host_only = true;
  assert.throws(() => f.session.prepareControl({paused: true, positionMs: 0}), e => e.code === 'host_only');
});

test('desktop parity: rapid commands never wait for a slow RPC; late or duplicate states cannot roll back newer ones', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.room.info.host_only = false;
  const pending = [], rpc = f.client.rpc;
  f.client.rpc = (name, args) => name === 'watch_party_update'
    ? new Promise(resolve => pending.push(() => resolve({data: {party: {...snapshot().party, host_only: false, playback: args.p_playback}}})))
    : rpc(name, args);
  const pause = await f.session.commitControl(f.session.prepareControl({paused: true, positionMs: 1000}), {mode: 'desktop'});
  const play = await f.session.commitControl(f.session.prepareControl({paused: false, positionMs: 1000}), {mode: 'desktop'});
  const seek = await f.session.commitControl(f.session.prepareControl({paused: false, positionMs: 11000}), {mode: 'desktop'});
  assert.deepEqual([pause.seq, play.seq, seek.seq], [3, 4, 5]); // Sequential without waiting for any RPC.
  assert.equal(pending.length, 3); assert.equal(f.session.playback, seek);
  pending.reverse().forEach(release => release()); await new Promise(resolve => setImmediate(resolve)); // Late replies, oldest last.
  assert.equal(f.session.playback, seek);
  f.emit('state', {...pause}); f.emit('state', {...seek}); // Duplicate/outdated realtime echoes.
  assert.equal(f.session.playback, seek); assert.equal(f.session.diagnostics.lastDecision, 'not_newer');
  f.session.acceptPlayback({...playback, seq: 4, paused: true}, 'snapshot'); // Stale snapshot.
  assert.equal(f.session.playback, seek);
});

