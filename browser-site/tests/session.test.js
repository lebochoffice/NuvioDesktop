import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {PartySession, connectionReason} from '../src/session.js';

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
test('browser creation requires account auth, real media identity and a server-confirmed host membership', async t => {
  const f = fixture(); t.after(() => f.session.close());
  const movie = {type: 'movie', meta_type: 'movie', meta_id: 'tt1234567', title: 'Catalog title'};
  const original = f.client.rpc;
  f.client.rpc = async (name, args) => {
    if (name === 'watch_party_create') {
      f.calls.push([name, args]);
      return {data: {...snapshot(), member_id: 'host', party: {...snapshot().party, media: movie}}};
    }
    return original(name, args);
  };
  await f.session.create(movie, 'Host', 0);
  assert.equal(f.session.isHost(), true);
  const request = f.calls.find(call => call[0] === 'watch_party_create')[1];
  assert.deepEqual(request.p_media, movie);
  assert.equal(request.p_playback, null);
  assert.equal(request.p_profile_index, 0);
  assert.equal(request.p_device_id, 'device');
  await f.session.close();
  f.client.rpc = async () => ({data: snapshot()});
  await assert.rejects(f.session.create(movie, 'Host'), /Host-Mitgliedschaft/);
  assert.equal(f.session.isHost(), false);
  f.client.auth.getSession = async () => ({data: {session: null}});
  await assert.rejects(f.session.create(movie, 'Host'), /angemeldetes/);
});

test('host-only, kick and end use authorized RPCs and reject guests', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  await assert.rejects(f.session.setHostOnly(false), /Host-Rolle/);
  await assert.rejects(f.session.endParty(), /Host-Rolle/);
  const original = f.client.rpc;
  f.client.rpc = async (name, args) => {
    if (name === 'watch_party_join' || name === 'watch_party_heartbeat' || name === 'watch_party_set_host_only' ||
        name === 'watch_party_remove_member' || name === 'watch_party_end') {
      f.calls.push([name, args]);
      return {data: {...snapshot(), member_id: 'host', party: {...snapshot().party,
        host_only: name === 'watch_party_set_host_only' ? args.p_host_only : true},
        members: snapshot().members.filter(member => member.id !== args.p_member_id)}};
    }
    return original(name, args);
  };
  // A reload restores the host role from join, with no stored role flag.
  await f.session.join('UXZ83H', 'Host');
  assert.equal(f.session.isHost(), true);
  await f.connect();
  await f.session.reconnect();
  await f.connect();
  assert.equal(f.session.isHost(), true);
  await f.session.setHostOnly(false);
  assert.equal(f.session.room.info.host_only, false);
  await f.session.removeMember('guest');
  assert.equal(f.session.room.members.some(member => member.id === 'guest'), false);
  await f.session.endParty();
  assert.equal(f.session.room, null);
  assert.ok(f.calls.some(call => call[0] === 'watch_party_end'));
});

test('a backend creation denial never grants local host rights', async () => {
  const f = fixture();
  f.client.rpc = async () => ({error: {code: '42501', message: 'denied'}});
  await assert.rejects(f.session.create({type: 'movie', meta_type: 'movie', meta_id: 'tt1234567', title: 'Catalog title'}, 'Host'),
    error => error.code === '42501');
  assert.equal(f.session.room, null);
  assert.equal(f.session.isHost(), false);
});

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
  await f.session.sendPresence('ready'); assert.equal(f.messages.at(-1).payload.status, 'ready');
  await f.session.sendPresence('behind', 5000); assert.equal(f.messages.at(-1).payload.behind_ms, 5000);
  assert.equal(f.tracks.length, 1);
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
  let release;
  const persisted = new Promise(resolve => { release = resolve; });
  f.ch.send = async message => { order.push(['send', message.event]); return send(message); };
  f.client.rpc = async (name, args) => { order.push(['rpc', name]); return name === 'watch_party_update'
    ? persisted.then(() => ({data: {party: {...snapshot().party, host_only: false, playback: {...playback, seq: 1}}}})) : rpc(name, args); };
  const stored = await f.session.commitControl(f.session.prepareControl({paused: true, positionMs: 7000}), {mode: 'desktop'});
  assert.deepEqual(order, [['send', 'state'], ['rpc', 'watch_party_update']]);
  assert.equal(f.session.playback, stored); assert.equal(stored.seq, 3); assert.equal(stored.member_id, 'guest');
  assert.equal(f.session.diagnostics.lastCommandResult, 'broadcast'); // Returns before the RPC finished.
  release(); await new Promise(resolve => setImmediate(resolve));
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


// --- Host-sequenced commands (fork protocol 1, 0.1.39). Written, not executed here. ---
async function sequenced(t, {announce = true} = {}) {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.room.info.host_only = false;
  if (announce) f.emit('status', {member_id: 'host', status: 'ready', commands: 1});
  return f;
}
const sentCommands = f => f.messages.filter(m => m.event === 'command').map(m => m.payload);
const hostState = (command, seq, extra = {}) => ({seq, member_id: 'host', paused: command.paused, position_ms: command.position_ms, rate: 1, at: 1000,
  media_key: 'movie|tt1||', waiting: false, origin_member_id: command.member_id, command_id: command.command_id, ...extra});
const ack = (command, status, extra = {}) => ({command_id: command.command_id, member_id: 'host', origin_member_id: 'guest', status, ...extra});
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sequencer capability comes only from the current host status; legacy hosts keep the old path', async t => {
  const f = await sequenced(t, {announce: false});
  assert.equal(f.session.canSequence(), false);
  assert.throws(() => f.session.issueCommand({paused: true, positionMs: 0}), e => e.code === 'no_sequencer');
  f.emit('status', {member_id: 'guest2', status: 'ready', commands: 1}); assert.equal(f.session.canSequence(), false);
  f.emit('status', {member_id: 'host', status: 'ready'}); assert.equal(f.session.canSequence(), false); // Older host.
  f.emit('status', {member_id: 'host', status: 'ready', commands: 1}); assert.equal(f.session.canSequence(), true);
  f.session.room.info.host_only = true; assert.equal(f.session.canSequence(), false);
  assert.throws(() => f.session.issueCommand({paused: true, positionMs: 0}), e => e.code === 'host_only');
});

test('browser pause: command with own ID and base revision; the host state accepts it, the host ack marks it applied', async t => {
  const f = await sequenced(t), events = [];
  f.session.handlers.command = entry => events.push(entry.status);
  const entry = f.session.issueCommand({paused: true, positionMs: 7000});
  const [command] = sentCommands(f);
  assert.equal(command.command_id, entry.id); assert.match(command.command_id, /^[A-Za-z0-9-]{8,64}$/);
  assert.deepEqual([command.member_id, command.paused, command.position_ms, command.base_seq, command.media_key, command.host_member_id],
    ['guest', true, 7000, 2, 'movie|tt1||', 'host']);
  assert.ok(!('seq' in command)); // Guests never assign revisions.
  assert.ok(!JSON.stringify(command).includes('session-jwt')); // No credentials in the payload.
  assert.equal(entry.status, 'pending');
  assert.equal(f.session.playback.seq, 2); assert.equal(f.session.optimisticPlayback().paused, true);
  f.emit('state', hostState(command, 3));
  assert.equal(f.session.playback.seq, 3); assert.equal(entry.status, 'accepted'); assert.equal(entry.reached, true);
  assert.equal(f.session.optimisticPlayback(), null);
  f.emit('ack', ack(command, 'accepted', {seq: 3})); // Duplicate confirmation: no second event.
  f.emit('ack', ack(command, 'applied', {seq: 3}));
  assert.equal(entry.status, 'applied'); assert.deepEqual(events, ['accepted', 'applied']);
});

test('browser play and seek are sequenced the same way; rapid commands chain on the same base without flicker', async t => {
  const f = await sequenced(t);
  const pause = f.session.issueCommand({paused: true, positionMs: 1000});
  const play = f.session.issueCommand({paused: false, positionMs: 1000});
  const seek = f.session.issueCommand({paused: false, positionMs: 61000, kind: 'seek'});
  assert.deepEqual(sentCommands(f).map(c => c.base_seq), [2, 2, 2]); // No waiting for any answer.
  f.emit('state', hostState(pause.command, 3)); // Our older command arrives first ...
  assert.equal(f.session.optimisticPlayback(), seek.optimistic); // ... and does not interrupt the newest preview.
  f.emit('state', hostState(play.command, 4));
  f.emit('state', hostState(seek.command, 5));
  assert.equal(f.session.optimisticPlayback(), null);
  assert.deepEqual([f.session.playback.seq, f.session.playback.position_ms, f.session.playback.paused], [5, 61000, false]);
});

test('desktop play right after a browser pause wins: a foreign newer revision ends the preview, the late rejection changes nothing', async t => {
  const f = await sequenced(t);
  const pause = f.session.issueCommand({paused: true, positionMs: 1000});
  f.emit('state', {...playback, seq: 3, member_id: 'host', paused: false, position_ms: 40000}); // Host's own Play first.
  assert.equal(f.session.optimisticPlayback(), null); assert.equal(f.session.playback.paused, false);
  f.emit('ack', ack(pause.command, 'rejected', {reason: 'superseded', seq: 3}));
  assert.equal(pause.status, 'rejected'); assert.equal(pause.reason, 'superseded');
  assert.equal(f.session.playback.seq, 3); assert.equal(sentCommands(f).length, 1); // No retry, no echo.
  // Accepted browser pause, then the host plays: the newer host revision applies.
  const pause2 = f.session.issueCommand({paused: true, positionMs: 41000});
  f.emit('state', hostState(pause2.command, 4));
  f.emit('state', {...playback, seq: 5, member_id: 'host', paused: false, position_ms: 41000});
  assert.equal(f.session.playback.paused, false); assert.equal(f.session.playback.seq, 5);
});

test('several browser guests: another guest command supersedes ours; acks for others are ignored', async t => {
  const f = await sequenced(t);
  const mine = f.session.issueCommand({paused: true, positionMs: 1000});
  const other = {command_id: 'other-guest-1', member_id: 'guest2', paused: false, position_ms: 9000};
  f.emit('state', hostState(other, 3));
  assert.equal(f.session.playback.origin_member_id, 'guest2'); assert.equal(f.session.optimisticPlayback(), null);
  assert.equal(mine.status, 'pending'); // Untouched by the other guest's revision.
  f.emit('ack', {...ack(other, 'accepted'), origin_member_id: 'guest2'}); assert.equal(mine.status, 'pending');
  f.emit('ack', ack(mine.command, 'rejected', {reason: 'superseded'})); assert.equal(mine.status, 'rejected');
});

test('forged acknowledgements and states of non-hosts cannot confirm a command', async t => {
  const f = await sequenced(t);
  const entry = f.session.issueCommand({paused: true, positionMs: 1000});
  f.emit('ack', {...ack(entry.command, 'accepted'), member_id: 'guest2'});
  f.emit('ack', {...ack(entry.command, 'applied'), origin_member_id: 'guest2'});
  f.emit('ack', ack({command_id: 'unknown-command'}, 'accepted'));
  assert.equal(entry.status, 'pending');
  f.emit('state', {...hostState(entry.command, 3), member_id: 'guest2'}); // Accepted as a revision (host_only=false) ...
  assert.equal(entry.status, 'pending'); assert.equal(entry.reached, false); // ... but not as the host's confirmation.
  f.emit('ack', ack(entry.command, 'rejected', {reason: '<script>'}));
  assert.equal(entry.reason, 'rejected'); // Unknown reasons are reduced to a fixed label.
});

test('out-of-order and duplicate realtime messages: older revisions are dropped, late acks only upgrade their own command', async t => {
  const f = await sequenced(t);
  const first = f.session.issueCommand({paused: true, positionMs: 1000});
  const second = f.session.issueCommand({paused: false, positionMs: 1000});
  f.emit('state', hostState(second.command, 4)); // Newer revision overtakes the older one.
  f.emit('state', hostState(first.command, 3));
  assert.equal(f.session.playback.seq, 4); assert.equal(f.session.diagnostics.lastDecision, 'not_newer');
  assert.equal(first.reached, false); assert.equal(first.status, 'pending');
  f.emit('ack', ack(first.command, 'accepted', {seq: 3})); // Late ack.
  assert.equal(first.status, 'accepted'); assert.equal(f.session.playback.seq, 4);
  assert.equal(f.session.latestCommand, second); assert.equal(f.session.optimisticPlayback(), null);
  f.emit('state', hostState(second.command, 4)); assert.equal(f.session.playback.seq, 4); // Duplicate.
});

test('no host answer: one retry with the same command ID, then UNKNOWN and the server snapshot; never endless resends', async t => {
  const f = await sequenced(t);
  f.session.ackTimeoutMs = 5;
  const entry = f.session.issueCommand({paused: true, positionMs: 1000});
  const heartbeats = () => f.calls.filter(c => c[0] === 'watch_party_heartbeat').length, before = heartbeats();
  await tick(40);
  const sent = sentCommands(f);
  assert.equal(sent.length, 2); assert.equal(sent[0].command_id, sent[1].command_id); // The host executes an ID at most once.
  assert.equal(entry.status, 'unknown'); assert.equal(f.session.optimisticPlayback(), null);
  assert.ok(heartbeats() > before); // Reconciled with the authoritative server state.
  await tick(30); assert.equal(sentCommands(f).length, 2);
  // The command may have succeeded after all (timeout after execution).
  f.emit('state', hostState(entry.command, 3));
  assert.equal(entry.status, 'accepted'); assert.equal(f.session.playback.seq, 3);
});

test('accepted but the ordered state never arrives: the preview ends and the state is requested again', async t => {
  const f = await sequenced(t);
  f.session.ackTimeoutMs = 5;
  const requests = () => f.messages.filter(m => m.event === 'state_request').length, before = requests();
  const entry = f.session.issueCommand({paused: true, positionMs: 1000});
  f.emit('ack', ack(entry.command, 'accepted', {seq: 3}));
  assert.equal(requests(), before + 1); // Missing seq 3 is asked for.
  assert.equal(f.session.optimisticPlayback(), entry.optimistic);
  await tick(30);
  assert.equal(entry.stale, true); assert.equal(f.session.optimisticPlayback(), null);
});

test('media change and host change end the epoch: pending commands are rejected locally and old acks ignored', async t => {
  const f = await sequenced(t);
  const entry = f.session.issueCommand({paused: true, positionMs: 1000});
  f.client.rpc = async () => ({data: {...snapshot(), party: {...snapshot().party, host_only: false, media: {...media, meta_id: 'tt2'}, playback: {...playback, seq: 0, media_key: 'movie|tt2||'}}}});
  await f.session.refresh();
  assert.equal(entry.status, 'rejected'); assert.equal(entry.reason, 'stale_epoch');
  assert.equal(f.session.latestCommand, null); assert.equal(f.session.optimisticPlayback(), null);
  f.emit('ack', ack(entry.command, 'accepted', {seq: 1})); assert.equal(entry.status, 'rejected');
  const g = await sequenced(t);
  const pending = g.session.issueCommand({paused: true, positionMs: 1000});
  g.client.rpc = async () => ({data: {...snapshot(), party: {...snapshot().party, host_only: false, host_member_id: 'host2', playback: {...playback, seq: 0, member_id: 'host2'}}}});
  await g.session.refresh();
  assert.equal(pending.reason, 'stale_epoch'); assert.equal(g.session.canSequence(), false); // The new host must announce itself.
});

test('reconnect: the authoritative snapshot is restored; closing clears commands and timers', async t => {
  const f = await sequenced(t);
  f.client.rpc = async name => name === 'watch_party_heartbeat'
    ? {data: {...snapshot(), party: {...snapshot().party, host_only: false, playback: {...playback, seq: 7, paused: true}}}}
    : {data: name === 'watch_party_clock' ? Date.now() : {messages: []}};
  await f.connect(); await tick(0);
  assert.equal(f.session.playback.seq, 7); assert.equal(f.session.playback.paused, true);
  assert.ok(f.messages.some(m => m.event === 'state_request'));
  const entry = f.session.issueCommand({paused: false, positionMs: 1000});
  assert.equal(entry.command.base_seq, 7);
  await f.session.close();
  assert.equal(f.session.canSequence(), false); assert.equal(f.session.commands.size, 0); assert.equal(f.session.commandTimers.size, 0);
});

// --- P0 after 0.1.39: realtime recovery and rejected-command catch-up. Written, not executed here. ---
// Separate channel objects per subscribe, so stale callbacks can be replayed.
function realtimeFixture() {
  const calls = [], messages = [], channels = [];
  const client = {
    auth: {getSession: async () => ({data: {session: {access_token: 'session-jwt-REFRESHED', user: {id: 'u', is_anonymous: false}}}})},
    realtime: {setAuth: async token => calls.push(['auth', token])},
    channel: () => {
      const ch = {events: [], on(_type, {event}, callback) { this.events.push({event, callback}); return this; },
        subscribe(callback) { this.cb = callback; }, track: async () => 'ok', send: async p => { messages.push(p); return 'ok'; }};
      channels.push(ch); calls.push(['channel']); return ch;
    },
    removeChannel: async ch => calls.push(['remove', channels.indexOf(ch)]),
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'watch_party_clock') return {data: Date.now()};
      if (name === 'watch_party_list_messages') return {data: {messages: []}};
      return {data: snapshot()};
    },
  };
  const session = new PartySession(client, 'device', {});
  session.reconnectBaseMs = 5; session.rejoinGraceMs = 20;
  return {client, calls, messages, channels, session, emit: (ch, event, payload) => ch.events.find(e => e.event === event).callback({payload})};
}

test('CLOSED is final in realtime-js: the channel is recreated with a refreshed token; stale callbacks are ignored', async t => {
  const f = realtimeFixture(), states = []; t.after(() => f.session.close());
  f.session.handlers.connection = s => states.push(s);
  await f.session.join('UXZ83H', 'Guest');
  const first = f.channels[0];
  await first.cb('SUBSCRIBED');
  await first.cb('CLOSED');
  assert.equal(f.session.diagnostics.connection, 'CLOSED');
  await tick(40);
  assert.equal(f.channels.length, 2); // New channel instead of a dead one.
  assert.ok(f.calls.some(c => c[0] === 'remove' && c[1] === 0));
  assert.equal(f.calls.filter(c => c[0] === 'auth').at(-1)[1], 'session-jwt-REFRESHED');
  assert.equal(f.session.channel, f.channels[1]); assert.equal(f.session.diagnostics.reconnects, 1);
  await first.cb('CLOSED'); await first.cb('SUBSCRIBED'); // Stale callbacks of the removed channel.
  assert.equal(f.session.diagnostics.connection, 'CONNECTING');
  f.emit(first, 'state', {...playback, seq: 50}); assert.equal(f.session.playback.seq, 2); // Old channel events are ignored.
  await f.channels[1].cb('SUBSCRIBED');
  assert.equal(f.session.diagnostics.connection, 'SUBSCRIBED');
  assert.ok(f.messages.filter(m => m.event === 'state_request').length >= 2); // Authoritative state requested again.
  assert.deepEqual(states.slice(0, 3), ['CONNECTING', 'SUBSCRIBED', 'CLOSED']);
  assert.equal(states.at(-1), 'SUBSCRIBED');
});

test('CHANNEL_ERROR / TIMED_OUT: realtime-js may rejoin by itself; only a rejoin that never succeeds recreates the channel', async t => {
  const f = realtimeFixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  const ch = f.channels[0];
  await ch.cb('CHANNEL_ERROR', new Error('socket closed'));
  await tick(5); await ch.cb('SUBSCRIBED'); // Automatic rejoin within the grace period.
  await tick(40);
  assert.equal(f.channels.length, 1); assert.equal(f.session.diagnostics.reconnects, 0);
  await ch.cb('TIMED_OUT');
  await tick(60);
  assert.equal(f.channels.length, 2); assert.equal(f.session.diagnostics.reconnects, 1);
});

test('the connection log keeps timestamps and fixed reason categories, never error texts or tokens', async t => {
  const f = realtimeFixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  await f.channels[0].cb('CHANNEL_ERROR', new Error('Token has expired eyJhbGciOiJIUzI1NiJ9.SECRET_SENTINEL'));
  const log = f.session.diagnostics.connectionLog;
  assert.equal(log.at(-1).state, 'CHANNEL_ERROR'); assert.equal(log.at(-1).reason, 'auth_token');
  assert.ok(!Number.isNaN(Date.parse(log.at(-1).at)));
  assert.ok(!JSON.stringify(f.session.diagnostics).includes('SECRET_SENTINEL'));
  assert.equal(connectionReason(new Error('Unauthorized: You do not have permissions')), 'not_authorized');
  assert.equal(connectionReason(new Error('ChannelRateLimitReached: Too many messages per second')), 'rate_limited');
  assert.equal(connectionReason(null), null);
});

test('reconnect() (refresh button while disconnected) rebuilds once even if called repeatedly; close cancels pending reconnects', async t => {
  const f = realtimeFixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  await f.channels[0].cb('CLOSED');
  await Promise.all([f.session.reconnect(), f.session.reconnect()]);
  assert.equal(f.channels.length, 2);
  await f.channels[1].cb('CLOSED');
  await f.session.close();
  await tick(60);
  assert.equal(f.channels.length, 2); assert.equal(f.session.reconnectTimer, null);
});

test('an expired Nuvio session is reported instead of reconnecting with an invalid token', async t => {
  const f = realtimeFixture(), errors = [], states = []; t.after(() => f.session.close());
  f.session.handlers.error = e => errors.push(e.message); f.session.handlers.connection = s => states.push(s);
  await f.session.join('UXZ83H', 'Guest');
  f.client.auth.getSession = async () => ({data: {session: null}});
  await f.session.reconnect();
  assert.equal(f.channels.length, 1); assert.equal(states.at(-1), 'CLOSED');
  assert.match(errors.at(-1), /Anmeldung abgelaufen/);
});

test('a rejected command with a newer host revision fetches that revision instead of keeping an outdated party state', async t => {
  const f = await sequenced(t);
  const entry = f.session.issueCommand({paused: true, positionMs: 1000});
  const requests = () => f.messages.filter(m => m.event === 'state_request').length, heartbeats = () => f.calls.filter(c => c[0] === 'watch_party_heartbeat').length;
  const [r, h] = [requests(), heartbeats()];
  f.emit('ack', ack(entry.command, 'rejected', {reason: 'host_only', seq: 9}));
  assert.equal(entry.status, 'rejected');
  assert.equal(requests(), r + 1); assert.equal(heartbeats(), h + 1);
});

// --- Position reports and end reasons. Written, not executed here. ---
test('position reports ride on the status event with allowlisted numbers only and never change playback', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  f.session.positionProvider = () => ({position_ms: 12345.6, playing: true, url: 'https://secret.example.test/x'});
  await f.session.reportPosition();
  const report = f.messages.filter(m => m.event === 'status').at(-1).payload;
  assert.equal(report.position_ms, 12346); assert.equal(report.playing, true); assert.ok(Number.isSafeInteger(report.position_at));
  assert.ok(!JSON.stringify(report).includes('secret'));
  await f.session.sendPresence('ready'); assert.equal(f.messages.at(-1).payload.position_ms, 12346);
  f.session.positionProvider = () => null; await f.session.reportPosition(); // Nothing loaded: no report.
  assert.equal(f.messages.filter(m => m.event === 'status').at(-1).payload.status, 'ready');
  f.emit('status', {member_id: 'host', status: 'ready', media_key: 'movie|tt1||', position_ms: 99999, position_at: 1, playing: true, seq: 99, paused: true});
  assert.equal(f.session.playback.seq, 2); assert.equal(f.session.memberStatus.get('host').position_ms, 99999);
  assert.ok(!('seq' in f.session.memberStatus.get('host')));
});

test('end reasons: a host change emits stream(null, "host_changed"); removal and party end are distinguished', async t => {
  const streams = [], ends = [], closes = [];
  const f = fixture({stream: (s, reason) => streams.push([s, reason]), ended: (m, reason) => ends.push(reason), closed: reason => closes.push(reason)});
  t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest');
  f.client.rpc = async () => ({data: {...snapshot(), party: {...snapshot().party, host_member_id: 'host2', playback: {...playback, seq: 0, member_id: 'host2'}}}});
  await f.session.refresh();
  assert.deepEqual(streams.at(-1), [null, 'host_changed']);
  f.client.rpc = async () => ({data: {error: 'removed'}});
  await f.session.refresh();
  assert.deepEqual([closes.at(-1), ends.at(-1)], ['removed', 'removed']);
  const g = fixture({ended: (m, reason) => ends.push(reason), closed: reason => closes.push(reason)}); t.after(() => g.session.close());
  await g.session.join('UXZ83H', 'Guest');
  g.client.rpc = async () => ({data: {members: []}}); // No party in the snapshot: ended.
  await g.session.refresh();
  assert.deepEqual([closes.at(-1), ends.at(-1)], ['ended', 'ended']);
  const h = fixture({closed: reason => closes.push(reason)}); t.after(() => h.session.close());
  await h.session.join('UXZ83H', 'Guest'); await h.session.close();
  assert.equal(closes.at(-1), null); // An explicit leave carries no end reason.
});

// --- Browser host: shared video link, own playback, proposals ---------------
async function hostFixture(t, handlers = {}) {
  const f = fixture(handlers); t.after(() => f.session.close());
  const rpc = f.client.rpc;
  f.client.rpc = async (name, args) => {
    const reply = await rpc(name, args);
    return ['watch_party_join', 'watch_party_heartbeat'].includes(name) ? {data: {...reply.data, member_id: 'host'}} : reply;
  };
  await f.session.join('UXZ83H', 'Host'); await f.connect();
  return f;
}
const hostLinkStream = {media_key: 'movie|tt1||', url: 'https://cdn.example.test/film.mp4', name: 'Video-Link des Hosts', stream_type: 'mp4', headers: {}, response_headers: {}};

test('the server-confirmed host controls even with host_only; its states are broadcast, then persisted', async t => {
  const f = await hostFixture(t);
  assert.equal(f.session.isHost(), true);
  assert.equal(f.session.room.info.host_only, true);
  assert.equal(f.session.canControl(), true); // A guest with host_only=true could not.
  const state = await f.session.hostPublish({paused: true, positionMs: 0});
  assert.equal(state.member_id, 'host'); assert.equal(state.paused, true); assert.equal(state.media_key, 'movie|tt1||');
  assert.ok(f.messages.some(m => m.event === 'state' && m.payload === state));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(c => c[0] === 'watch_party_update' && c[1].p_playback.seq === state.seq)); // Authorized by the backend.
  assert.equal(f.session.playback.seq, state.seq);
});

test('a guest can neither publish as host nor share a link; only the host answers state requests with its link', async t => {
  const g = fixture(); t.after(() => g.session.close());
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  await assert.rejects(g.session.hostPublish({paused: true, positionMs: 0}), e => e.code === 'host_only');
  await assert.rejects(g.session.shareHostStream(hostLinkStream), /Host-Rolle/);
  const f = await hostFixture(t);
  await f.session.shareHostStream(hostLinkStream);
  const first = f.messages.filter(m => m.event === 'stream').at(-1).payload;
  assert.equal(first.member_id, 'host');
  assert.equal(first.media_key, hostLinkStream.media_key);
  assert.equal(first.stream, hostLinkStream);
  await f.session.hostPublish({paused: false, positionMs: 5000});
  const before = f.messages.length;
  f.emit('state_request', {member_id: 'guest'}); // Late joiner or reconnect.
  await new Promise(resolve => setImmediate(resolve));
  const answers = f.messages.slice(before);
  assert.ok(answers.some(m => m.event === 'stream' && m.payload.stream === hostLinkStream));
  assert.ok(answers.some(m => m.event === 'state' && m.payload.position_ms === 5000));
  await f.session.stopHostStream();
  const revoked = f.messages.filter(m => m.event === 'stream').at(-1).payload;
  assert.equal(revoked.member_id, first.member_id);
  assert.equal(revoked.media_key, first.media_key);
  assert.ok(revoked.source_revision > first.source_revision);
  assert.equal(revoked.stream, null);
});

test('proposals reach only the host; decisions reach only the proposing member', async t => {
  const proposals = [], f = await hostFixture(t, {proposal: p => proposals.push(p)});
  f.session.browserHostLinksEnabled = true;
  f.emit('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'});
  assert.equal(proposals.length, 1);
  await f.session.answerProposal('guest', false);
  assert.deepEqual(f.messages.at(-1).payload, {member_id: 'host', target_member_id: 'guest', status: 'declined'});
  const results = [], g = fixture({proposal: p => proposals.push(p), proposalResult: r => results.push(r)}); t.after(() => g.session.close());
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  g.emit('browser_stream_suggest', {member_id: 'guest', target_member_id: 'host', media_key: 'movie|tt1||', url: 'https://cdn.example.test/a.mp4'});
  assert.equal(proposals.length, 1); // A guest never receives proposals.
  g.emit('stream_suggest_result', {member_id: 'intruder', target_member_id: 'guest', status: 'accepted'}); // Not the host.
  g.emit('stream_suggest_result', {member_id: 'host', target_member_id: 'other', status: 'accepted'});
  g.emit('stream_suggest_result', {member_id: 'host', target_member_id: 'guest', status: 'accepted'});
  assert.deepEqual(results, ['accepted']);
});

test('a host that shares nothing answers state requests without a stream offer or revocation', async t => {
  const f = await hostFixture(t);
  const before = f.messages.length;
  f.emit('state_request', {member_id: 'guest'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.messages.slice(before).filter(m => m.event === 'stream').length, 0);
});

test('host source: a failed send keeps the previous offer and is never resent; a failed revocation keeps it too', async t => {
  const f = await hostFixture(t);
  await f.session.shareHostStream(hostLinkStream);
  const send = f.ch.send;
  f.ch.send = async p => { f.messages.push(p); return 'error'; };
  await assert.rejects(f.session.shareHostStream({...hostLinkStream, url: 'https://cdn.example.test/other.mp4'}));
  assert.equal(f.session.hostStream, hostLinkStream);
  await assert.rejects(f.session.stopHostStream());
  assert.equal(f.session.hostStream, hostLinkStream);
  f.ch.send = send;
  const before = f.messages.length;
  f.emit('state_request', {member_id: 'guest'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.messages.slice(before).filter(m => m.event === 'stream').map(m => m.payload.stream), [hostLinkStream]);
});

test('reconnect: a sharing host announces its offer and party time again once subscribed', async t => {
  const f = await hostFixture(t);
  await f.session.shareHostStream(hostLinkStream);
  await f.session.hostPublish({paused: false, positionMs: 7000});
  const before = f.messages.length;
  await f.connect(); // SUBSCRIBED again after a reconnect.
  const again = f.messages.slice(before);
  assert.ok(again.some(m => m.event === 'stream' && m.payload.stream === hostLinkStream));
  assert.ok(again.some(m => m.event === 'state' && m.payload.position_ms === 7000));
});

test('late completion after leaving cannot restore a pending offer, and revoke is serialized', async t => {
  const f = await hostFixture(t);
  let complete;
  f.ch.send = () => new Promise(resolve => { complete = resolve; });
  const sharing = f.session.shareHostStream(hostLinkStream);
  const rejected = assert.rejects(sharing, {code: 'closed'});
  await assert.rejects(f.session.stopHostStream(), /läuft bereits/);
  await f.session.close();
  complete('ok');
  await rejected;
  assert.equal(f.session.hostStream, null);
  assert.equal(f.session.hostOffer, null);
});

test('a missed revocation is replayed and a delayed older offer cannot restore the source', async t => {
  const f = await hostFixture(t);
  const received = [], g = fixture({stream: value => received.push(value)});
  t.after(() => g.session.close());
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  await f.session.shareHostStream(hostLinkStream);
  const old = f.messages.filter(message => message.event === 'stream').at(-1).payload;
  g.emit('stream', old);
  await f.session.stopHostStream(); // Guest misses the initial tombstone.
  f.emit('state_request', {member_id: 'guest'});
  const replay = f.messages.filter(message => message.event === 'stream').at(-1).payload;
  assert.equal(replay.stream, null);
  assert.ok(replay.source_revision > old.source_revision);
  g.emit('stream', replay);
  g.emit('stream', old);
  assert.deepEqual(received, [hostLinkStream, null]);
});

test('a failed start and failed rollback never replay the uncommitted source', async t => {
  const f = await hostFixture(t);
  await f.session.shareHostStream(hostLinkStream);
  const candidate = {...hostLinkStream, url: 'https://cdn.example.test/other.mp4'};
  const send = f.ch.send;
  f.ch.send = async message => message.event === 'stream' && message.payload.stream === candidate ? send(message) : 'error';
  await assert.rejects(f.session.shareHostStream(candidate, {paused: true, positionMs: 0}), {code: 'share_restore_failed'});
  assert.equal(f.session.hostStream, hostLinkStream);
  f.ch.send = send;
  f.emit('state_request', {member_id: 'guest'});
  assert.equal(f.messages.filter(message => message.event === 'stream').at(-1).payload.stream, hostLinkStream);
});

test('a heartbeat can promote a browser in the same room and hand it a confirmed source and last playback', async t => {
  const promoted = [], f = fixture({promoted: value => promoted.push(value)});
  t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  const room = f.session.room;
  f.emit('stream', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: 1, stream: hostLinkStream});
  f.emit('stream_commit', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: 1});
  assert.equal(f.session.isHost(), false);
  const next = snapshot();
  next.party.host_member_id = 'guest'; next.party.playback = null;
  next.members = next.members.filter(member => member.id === 'guest');
  f.client.rpc = async () => ({data: next});
  await f.session.refresh();
  assert.equal(f.session.room, room);
  assert.equal(room.info.code, 'UXZ83H');
  assert.equal(f.session.isHost(), true);
  assert.deepEqual(promoted, [{stream: hostLinkStream, playback}]);
  f.emit('state', {...playback, seq: 999});
  assert.equal(f.session.playback, null);
});

test('an uncommitted or revoked offer cannot be inherited on promotion', async t => {
  for (const revoked of [false, true]) {
    const promoted = [], f = fixture({promoted: value => promoted.push(value)});
    t.after(() => f.session.close());
    await f.session.join('UXZ83H', 'Guest'); await f.connect();
    f.emit('stream', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: 1, stream: hostLinkStream});
    if (revoked) {
      f.emit('stream_commit', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: 1});
      f.emit('stream', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: 2, stream: null});
    }
    const next = snapshot();
    next.party.host_member_id = 'guest';
    f.client.rpc = async () => ({data: next});
    await f.session.refresh();
    assert.deepEqual(promoted, [null]);
  }
});

test('a host change rejects the old heartbeat playback even when guest control is allowed', async t => {
  const f = fixture(); t.after(() => f.session.close());
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  const replacement = snapshot();
  replacement.party.host_member_id = 'new-host';
  replacement.party.host_only = false;
  replacement.members = [{id: 'new-host'}, {id: 'guest'}];
  f.client.rpc = async () => ({data: replacement});
  await f.session.refresh();
  assert.equal(f.session.playback, null);
  assert.equal(f.session.canControl(), false);
  f.emit('state', {...playback, seq: 500});
  assert.equal(f.session.playback, null);
  f.emit('state', {...playback, member_id: 'new-host', seq: 0, position_ms: 5020000});
  assert.equal(f.session.playback.position_ms, 5020000);
  assert.equal(f.session.canControl(), true);
  await f.session.refresh();
  assert.equal(f.session.playback.member_id, 'new-host');
});

test('a reconnected former host checks the heartbeat before reannouncing its source', async t => {
  const f = await hostFixture(t);
  await f.session.shareHostStream(hostLinkStream);
  let resolveHeartbeat;
  f.client.rpc = name => name === 'watch_party_heartbeat' ? new Promise(resolve => { resolveHeartbeat = resolve; }) : Promise.resolve({data: {}});
  const before = f.messages.length, reconnecting = f.connect();
  f.emit('state_request', {member_id: 'guest'});
  assert.equal(f.messages.slice(before).some(message => message.event === 'stream'), false);
  const replacement = snapshot();
  replacement.party.host_member_id = 'guest';
  replacement.member_id = 'host';
  resolveHeartbeat({data: replacement});
  await reconnecting;
  assert.equal(f.session.isHost(), false);
  assert.equal(f.messages.slice(before).some(message => message.event === 'stream'), false);
});

test('host recovery uses the committed guest copy and reannounces its original revision without writing playback', async t => {
  const candidates = [], f = await hostFixture(t, {sourceRecoveryCandidate: value => candidates.push(value)});
  const g = fixture(); t.after(() => g.session.close(false));
  f.session.browserHostLinksEnabled = g.session.browserHostLinksEnabled = true;
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  const revision = 500;
  g.emit('stream', {member_id: 'host', media_key: hostLinkStream.media_key, source_revision: revision, stream: hostLinkStream, handoff_ready: true});
  const state = f.session.playback;
  f.session.armSourceRecovery();
  const request = f.messages.find(message => message.event === 'browser_source_request').payload;
  g.emit('browser_source_request', request);
  const reply = g.messages.find(message => message.event === 'browser_source_reply').payload;
  f.emit('browser_source_reply', reply);
  assert.equal(candidates.length, 1);
  assert.equal(f.session.hostStream, null);
  assert.equal(f.session.completeSourceRecovery(candidates[0]), true);
  assert.equal(f.session.playback, state);
  assert.equal(f.session.hostOffer.source_revision, revision);
  assert.ok(!f.calls.some(([name]) => name === 'watch_party_update'));
  f.emit('browser_source_reply', reply);
  assert.equal(candidates.length, 1);
});

test('recovery fails closed on a conflicting or revoked revision regardless of response order', async t => {
  for (const reversed of [false, true]) {
    const candidates = [], failures = [];
    const f = await hostFixture(t, {sourceRecoveryCandidate: value => candidates.push(value), sourceRecoveryUnavailable: () => failures.push(true)});
    f.session.browserHostLinksEnabled = true;
    f.session.room.members.push({id: 'other'});
    f.session.armSourceRecovery();
    const request = f.messages.find(message => message.event === 'browser_source_request').payload;
    const reports = [{member_id: 'guest', source_revision: 1, stream: hostLinkStream},
      {member_id: 'other', source_revision: 2, stream: null}];
    for (const report of reversed ? reports.reverse() : reports) f.emit('browser_source_reply', {...request, ...report});
    assert.deepEqual(candidates, []);
    assert.equal(failures.length, 1);
    assert.equal(f.session.hostStream, null);
  }
});

test('only the current host can request recovery and replies from a replaced connection are ignored', async t => {
  const candidates = [], f = await hostFixture(t, {sourceRecoveryCandidate: value => candidates.push(value)});
  f.session.browserHostLinksEnabled = true;
  f.session.armSourceRecovery();
  const first = f.messages.find(message => message.event === 'browser_source_request').payload;
  await f.session.reconnect();
  await f.connect();
  const last = f.messages.filter(message => message.event === 'browser_source_request').at(-1).payload;
  assert.notEqual(first.request_id, last.request_id);
  f.emit('browser_source_reply', {...first, member_id: 'guest', source_revision: 1, stream: hostLinkStream});
  assert.deepEqual(candidates, []);
  f.session.room.info.host_member_id = 'guest';
  f.emit('browser_source_reply', {...last, member_id: 'guest', source_revision: 1, stream: hostLinkStream});
  assert.deepEqual(candidates, []);
});

test('a host alone asks for manual sharing, and a rejoined guest never sends a recovery request', async t => {
  let failures = 0;
  const f = await hostFixture(t, {sourceRecoveryUnavailable: () => { failures++; }});
  f.session.browserHostLinksEnabled = true;
  f.session.room.members = [{id: 'host'}];
  f.session.armSourceRecovery();
  assert.equal(failures, 1);
  assert.ok(!f.messages.some(message => message.event === 'browser_source_request'));
  const g = fixture(); t.after(() => g.session.close(false));
  g.session.browserHostLinksEnabled = true;
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  g.session.armSourceRecovery();
  assert.ok(!g.messages.some(message => message.event === 'browser_source_request'));
});

// Controlled timers: no sleep or network, and the production deadlines remain unchanged.
function controlledTimeouts(t) {
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const handle = {unref() {}};
    timers.set(handle, {callback, delay});
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => timers.delete(handle));
  return {
    fire(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `Missing timer for ${delay} ms`);
      timers.delete(entry[0]);
      return entry[1].callback();
    },
    has: delay => [...timers.values()].some(timer => timer.delay === delay),
  };
}

test('three subscribers answer one another’s state requests with status, without additional Presence tracks', async t => {
  const browsers = [fixture(), fixture(), fixture()];
  for (const [index, f] of browsers.entries()) {
    t.after(() => f.session.close(false));
    await f.session.join('UXZ83H', 'Guest');
    f.session.room.memberId = index === 0 ? 'host' : 'guest-' + index;
    f.session.browserHostLinksEnabled = index === 0;
    await f.connect();
  }
  for (const sender of browsers) {
    await sender.session.requestState();
    const request = sender.messages.at(-1).payload;
    for (const receiver of browsers) receiver.emit('state_request', request);
  }
  for (const f of browsers) {
    assert.equal(f.tracks.length, 1);
    assert.equal(f.messages.filter(m => m.event === 'status').length, 3);
    assert.equal(f.session.playback.seq, playback.seq);
  }
  const hostStatus = browsers[0].messages.findLast(m => m.event === 'status').payload;
  assert.equal(hostStatus.browser_host_links, 1);
  browsers[1].emit('status', hostStatus);
  assert.equal(browsers[1].session.browserHostLinks, true);
});

test('Presence coalesces latest status and spaces tracks across reconnects and fresh joins', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timers = controlledTimeouts(t), f = fixture();
  t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Guest'); await f.connect();
  const sentAt = [now];
  for (let i = 1; i <= 5; i++) {
    if (i === 3) await f.session.join('UXZ83H', 'Guest');
    else await f.session.reconnect();
    await f.connect();
    await f.session.sendPresence('ready');
    await f.session.sendPresence('buffering');
    await f.session.sendPresence('behind', 1000 * i);
    assert.equal(f.tracks.length, i);
    assert.equal(f.messages.at(-1).payload.behind_ms, 1000 * i);
    now += 6250;
    await timers.fire(6250);
    sentAt.push(now);
    assert.equal(f.tracks.length, i + 1);
    assert.equal(f.tracks.at(-1).status, 'behind');
    assert.equal(f.tracks.at(-1).behind_ms, 1000 * i);
    assert.equal(timers.has(6250), false);
  }
  for (const start of sentAt) assert.ok(sentAt.filter(at => at >= start && at - start < 30000).length <= 5);
});

test('server Presence limit delays automatic and manual reconnect until cooldown, then revalidates guest control', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timers = controlledTimeouts(t), f = realtimeFixture();
  t.after(() => f.session.close(false));
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => name === 'watch_party_heartbeat'
    ? Promise.resolve({data: {...snapshot(), party: {...snapshot().party, host_only: false}}})
    : rpc(name, args);
  await f.session.join('UXZ83H', 'Guest'); await f.channels[0].cb('SUBSCRIBED');
  const old = f.channels[0];
  old.events.find(e => e.event === undefined).callback({
    status: 'error', extension: 'system', message: 'Client presence rate limit exceeded SECRET_SENTINEL',
  });
  await old.cb('CLOSED');
  assert.equal(f.session.diagnostics.serverError.reason, 'client_presence_limit');
  assert.equal(f.session.diagnostics.serverError.source, 'system');
  assert.ok(!JSON.stringify(f.session.diagnostics).includes('SECRET_SENTINEL'));
  assert.equal(f.session.canControl(), false);
  await f.session.reconnect();
  assert.equal(f.channels.length, 1);
  now = 31000; timers.fire(31000); await f.session.reconnecting;
  assert.equal(f.channels.length, 2);
  assert.equal(f.session.canControl(), false);
  await f.channels[1].cb('SUBSCRIBED');
  assert.equal(f.session.hostOfferDeferred, false);
  assert.equal(f.session.canControl(), true);
  f.session.room.info.host_only = true;
  assert.equal(f.session.canControl(), false);
});

test('a heartbeat from a removed channel cannot swallow validation of its subscribed replacement', async t => {
  const f = realtimeFixture(); t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Guest'); await f.channels[0].cb('SUBSCRIBED');
  let release, calls = 0;
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => {
    if (name !== 'watch_party_heartbeat') return rpc(name, args);
    if (++calls === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({data: {...snapshot(), party: {...snapshot().party, playback: {...playback, seq: 7}}}});
  };
  const stale = f.session.refresh();
  await f.session.reconnect(); await f.channels[1].cb('SUBSCRIBED');
  assert.equal(f.session.hostOfferDeferred, true);
  const validated = new Promise(resolve => { f.session.handlers.room = resolve; });
  release({data: {...snapshot(), party: {...snapshot().party, playback: {...playback, seq: 99}}}});
  await stale; await validated;
  assert.equal(calls, 2);
  assert.equal(f.session.hostOfferDeferred, false);
  assert.equal(f.session.playback.seq, 7);
  assert.ok(Number.isFinite(f.session.diagnostics.lastHeartbeatAt));
});

test('three independent browser clients: a third join and guest reconnect never reconnect the other clients', async t => {
  // Account identity and device identity are separate. The mock confirms the
  // membership; this does not claim what the live backend allows per account.
  for (const sameAccount of [true, false]) {
    const clients = ['a', 'b', 'c'].map(() => realtimeFixture());
    for (const [i, f] of clients.entries()) {
      t.after(() => f.session.close(false));
      f.session.deviceId = `device-${i}`;
      f.client.auth.getSession = async () => ({data: {session: {
        access_token: 'SYNTHETIC_SESSION', user: {id: sameAccount ? 'account' : `account-${i}`, is_anonymous: false},
      }}});
      const rpc = f.client.rpc;
      f.client.rpc = async (name, args) => {
        const response = await rpc(name, args);
        return ['watch_party_join', 'watch_party_heartbeat'].includes(name)
          ? {data: {...snapshot(), member_id: i === 0 ? 'host' : `guest-${i}`,
            members: [{id: 'host'}, {id: 'guest-1'}, {id: 'guest-2'}]}} : response;
      };
      await f.session.join('UXZ83H', 'Member');
      await f.channels[0].cb('SUBSCRIBED');
    }
    const [a, b, c] = clients;
    for (const f of [a, b]) {
      const before = f.session.playback, transitions = [];
      f.session.handlers.connection = state => transitions.push(state);
      const refreshed = new Promise(resolve => { f.session.handlers.room = resolve; });
      f.emit(f.channels[0], 'member_joined', {member_id: 'guest-2'});
      f.emit(f.channels[0], 'state_request', {member_id: 'guest-2'});
      await refreshed;
      assert.equal(f.session.playback, before);
      assert.deepEqual(transitions, []);
      assert.equal(f.channels.length, 1);
    }
    await c.session.reconnect(); await c.channels[1].cb('SUBSCRIBED');
    assert.deepEqual(clients.map(f => f.channels.length), [1, 1, 2]);
    assert.deepEqual(clients.map(f => f.session.diagnostics.reconnects), [0, 0, 1]);
  }
});

test('duplicate device values are sent unchanged to the backend and do not themselves trigger local channel eviction', async t => {
  const a = realtimeFixture(), b = realtimeFixture();
  for (const f of [a, b]) {
    t.after(() => f.session.close(false));
    await f.session.join('UXZ83H', 'Member'); await f.channels[0].cb('SUBSCRIBED');
    f.session.attachRealtime(f.session.generation); // Guard a second local attach.
    assert.equal(f.channels.length, 1);
    assert.equal(f.calls.find(([name]) => name === 'watch_party_join')[1].p_device_id, 'device');
  }
  assert.equal(a.session.diagnostics.connection, 'SUBSCRIBED');
  // Whether the real server replaces a duplicate membership is a live check.
});

test('failed reconnect retries after releasing its lock; two-second closed cycles never overlap channels', async t => {
  const timers = controlledTimeouts(t), f = realtimeFixture();
  t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Member'); await f.channels[0].cb('SUBSCRIBED');
  const auth = f.client.realtime.setAuth;
  f.client.realtime.setAuth = async () => { throw new Error('network SYNTHETIC_SECRET'); };
  await f.session.reconnect();
  assert.equal(f.session.reconnecting, null);
  assert.ok(f.session.reconnectTimer);
  assert.ok(!JSON.stringify(f.session.diagnostics).includes('SYNTHETIC_SECRET'));
  f.client.realtime.setAuth = auth;
  timers.fire(10); await f.session.reconnecting;
  await f.channels.at(-1).cb('SUBSCRIBED');
  f.session.reconnectBaseMs = 2000;
  for (let i = 0; i < 3; i++) {
    const old = f.channels.at(-1), count = f.channels.length;
    await old.cb('CLOSED'); await old.cb('CLOSED');
    timers.fire(2000);
    const pending = f.session.reconnecting;
    assert.equal(f.session.reconnect(), pending);
    await pending;
    assert.equal(f.channels.length, count + 1);
    await old.cb('CLOSED'); // Stale callback cannot close its replacement.
    assert.equal(f.session.diagnostics.connection, 'CONNECTING');
    await f.channels.at(-1).cb('SUBSCRIBED');
    assert.equal(f.session.reconnectTimer, null);
  }
});

test('host refresh with two guests retries a lost reply once and accepts only both identical committed copies', async t => {
  const timers = controlledTimeouts(t), candidates = [];
  const f = await hostFixture(t, {sourceRecoveryCandidate: attempt => candidates.push(attempt)});
  f.session.browserHostLinksEnabled = true;
  f.session.room.members.push({id: 'other'});
  f.session.armSourceRecovery();
  const request = f.messages.find(message => message.event === 'browser_source_request').payload;
  const reply = {...request, member_id: 'guest', source_revision: 42, stream: hostLinkStream};
  f.emit('browser_source_reply', reply);
  assert.equal(candidates.length, 0);
  timers.fire(1750);
  const repeated = f.messages.filter(message => message.event === 'browser_source_request');
  assert.equal(repeated.length, 2);
  assert.deepEqual(repeated[1].payload, request);
  f.emit('browser_source_reply', reply); // Duplicate is not the second member.
  assert.equal(f.session.diagnostics.recoveryReplies, 1);
  f.emit('browser_source_reply', {...reply, member_id: 'other'});
  assert.equal(candidates.length, 1);
  assert.equal(f.session.completeSourceRecovery(candidates[0]), true);
  assert.equal(f.session.diagnostics.recoveryResult, 'recovered');
  assert.equal(timers.has(3500), false);
});

test('an offline peer or permanently lost reply times out without choosing a partial recovery quorum', async t => {
  const timers = controlledTimeouts(t), failures = [];
  const f = await hostFixture(t, {sourceRecoveryUnavailable: reason => failures.push(reason)});
  f.session.browserHostLinksEnabled = true;
  f.session.room.members.push({id: 'offline'});
  f.session.armSourceRecovery();
  const request = f.messages.find(message => message.event === 'browser_source_request').payload;
  f.emit('browser_source_reply', {...request, member_id: 'guest', source_revision: 1, stream: hostLinkStream});
  timers.fire(1750); timers.fire(3500);
  assert.deepEqual(failures, ['timeout']);
  assert.equal(f.session.hostStream, null);
  assert.equal(f.session.sourceRecovery, null);
  assert.equal(f.session.diagnostics.recoveryExpected, 2);
  assert.equal(f.session.diagnostics.recoveryReplies, 1);
  f.emit('browser_source_reply', {...request, member_id: 'offline', source_revision: 1, stream: hostLinkStream});
  assert.equal(f.session.hostStream, null);
});

test('a lost commit stays unconfirmed; only an identical committed host replay repairs it', async t => {
  const g = fixture(); t.after(() => g.session.close(false));
  await g.session.join('UXZ83H', 'Guest'); await g.connect();
  g.session.browserHostLinksEnabled = true;
  const offer = {member_id: 'host', media_key: playback.media_key, source_revision: 8, stream: hostLinkStream};
  const request = {request_id: 'recovery-test-1', party_id: 'room-1', media_key: playback.media_key, host_member_id: 'host'};
  g.emit('stream', offer);
  g.emit('browser_source_request', request);
  assert.equal(g.messages.at(-1).payload.stream, null);
  g.emit('stream', {...offer, handoff_ready: true});
  g.emit('browser_source_request', request);
  assert.deepEqual(g.messages.at(-1).payload.stream, hostLinkStream);
  g.emit('stream', {...offer, stream: {...hostLinkStream, url: 'https://other.example.test/movie.mp4'}, handoff_ready: true});
  g.emit('stream_commit', offer);
  g.emit('browser_source_request', request);
  assert.equal(g.messages.at(-1).payload.stream, null);
});

test('reconnect during recovery cancels both old timers and starts a fresh request after role revalidation', async t => {
  const timers = controlledTimeouts(t), f = await hostFixture(t);
  f.session.browserHostLinksEnabled = true;
  f.session.armSourceRecovery();
  const old = f.session.sourceRecovery;
  await f.session.reconnect();
  assert.equal(f.session.diagnostics.recoveryResult, 'channel_lost');
  assert.equal(timers.has(1750), false);
  assert.equal(timers.has(3500), false);
  await f.connect();
  assert.ok(f.session.sourceRecovery);
  assert.notEqual(f.session.sourceRecovery.id, old.id);
  f.emit('browser_source_reply', {request_id: old.id, party_id: 'room-1', host_member_id: 'host',
    media_key: playback.media_key, member_id: 'guest', source_revision: 1, stream: hostLinkStream});
  assert.equal(f.session.diagnostics.recoveryReplies, 0);
});

test('CLOSED on an open socket is recorded before any local removal; stale cleanup cannot close the replacement', async t => {
  const f = realtimeFixture(); t.after(() => f.session.close(false));
  f.client.realtime.isConnected = () => true;
  await f.session.join('UXZ83H', 'Guest'); await f.channels[0].cb('SUBSCRIBED');
  const old = f.channels[0];
  await old.cb('CLOSED');
  assert.deepEqual(f.session.diagnostics.lifecycle.map(e => e.action), ['subscribe', 'closed']);
  assert.equal(f.session.diagnostics.lifecycle.at(-1).socketConnected, true);
  assert.equal(f.calls.filter(([name]) => name === 'remove').length, 0);
  await f.session.reconnect(); await f.channels[1].cb('SUBSCRIBED');
  await old.cb('CLOSED');
  assert.equal(f.session.diagnostics.lifecycle.at(-1).reason, 'stale');
  assert.equal(f.session.diagnostics.connection, 'SUBSCRIBED');
  assert.equal(f.session.channel, f.channels[1]);
  assert.equal(f.session.diagnostics.lifecycle.find(e => e.action === 'remove_start').reason, 'reconnect');
});

test('host-refresh recovery idle with a pending role starts only after the authoritative heartbeat', async t => {
  const f = await hostFixture(t);
  f.session.browserHostLinksEnabled = true;
  f.session.hostOfferDeferred = true;
  f.session.armSourceRecovery();
  assert.ok(f.session.sourceRecoveryScope);
  assert.equal(f.session.diagnostics.recoveryExpected, 0);
  assert.equal(f.session.diagnostics.recoveryResult, 'idle');
  assert.ok(!f.messages.some(message => message.event === 'browser_source_request'));
  let release;
  const rpc = f.client.rpc;
  f.client.rpc = name => name === 'watch_party_heartbeat' ? new Promise(resolve => { release = resolve; }) : rpc(name);
  const refresh = f.session.refresh();
  assert.equal(f.session.diagnostics.heartbeatResult, 'pending');
  release({data: {...snapshot(), member_id: 'host'}});
  await refresh;
  assert.equal(f.session.hostOfferDeferred, false);
  assert.equal(f.session.diagnostics.heartbeatResult, 'ok');
  assert.ok(f.messages.some(message => message.event === 'browser_source_request'));
});

test('presence loss only requests a snapshot: neither a missing host nor guest elects a host locally', async t => {
  const timers = controlledTimeouts(t), f = realtimeFixture();
  t.after(() => f.session.close(false));
  await f.session.join('UXZ83H', 'Guest'); await f.channels[0].cb('SUBSCRIBED');
  const ch = f.channels[0], presenceLeft = ch.events.find(event => event.event === 'leave').callback;
  const previous = f.session.playback;
  const before = f.calls.filter(([name]) => name === 'watch_party_heartbeat').length;
  presenceLeft({key: 'host', currentPresences: [{online: true}]}); // Another connection still exists.
  assert.equal(timers.has(1500), false);
  presenceLeft({key: 'host', currentPresences: []});
  presenceLeft({key: 'host', currentPresences: []});
  assert.equal(f.session.isHost(), false); assert.equal(f.session.playback, previous);
  const refreshed = new Promise(resolve => { f.session.handlers.room = resolve; });
  timers.fire(1500); await refreshed;
  assert.equal(f.calls.filter(([name]) => name === 'watch_party_heartbeat').length, before + 1);
  assert.equal(f.session.isHost(), false); assert.equal(f.session.playback, previous);
  assert.equal(f.channels.length, 1);
  // A later server snapshot, not the hint, promotes this member.
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => name === 'watch_party_heartbeat'
    ? Promise.resolve({data: {...snapshot(), party: {...snapshot().party, host_member_id: 'guest', host_only: false,
      playback: {...playback, seq: 0, member_id: 'guest'}}, members: [{id: 'guest'}, {id: 'remaining'}]}})
    : rpc(name, args);
  await f.session.refresh();
  assert.equal(f.session.isHost(), true); assert.equal(f.session.room.info.host_only, false);
  presenceLeft({key: 'remaining', currentPresences: []});
  assert.equal(f.session.isHost(), true);
  const sameRole = new Promise(resolve => { f.session.handlers.room = resolve; });
  timers.fire(1500); await sameRole;
  assert.equal(f.session.isHost(), true); assert.equal(f.channels.length, 1);
});

test('regular leave reaches the backend even while channel removal is pending, and cleanup stays serialized', async t => {
  const f = await hostFixture(t);
  let finishRemoval, leaveStarted;
  const removal = new Promise(resolve => { finishRemoval = resolve; });
  const departed = new Promise(resolve => { leaveStarted = resolve; });
  f.client.removeChannel = () => removal;
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => {
    if (name === 'watch_party_leave') leaveStarted();
    return rpc(name, args);
  };
  const closing = f.session.close();
  await departed;
  assert.equal(f.session.room, null); assert.equal(f.session.closing, closing);
  finishRemoval(); await closing;
  assert.equal(f.session.closing, null);
  assert.equal(f.calls.filter(([name]) => name === 'watch_party_leave').length, 1);
});
