import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createRealtimeTrace} from '../src/realtime-trace.js';

test('SDK trace distinguishes incoming phx_close, local leave and socket close without retaining payloads', () => {
  const trace = createRealtimeTrace();
  const privateData = {token: 'SECRET_SENTINEL', url: 'https://private.example.test/video?token=SECRET_SENTINEL'};
  trace.logger('receive', 'realtime:watch-party:PRIVATE_ID phx_close (8)', privateData);
  trace.logger('push', 'realtime:watch-party:PRIVATE_ID phx_leave (1, 9)', privateData);
  trace.logger('transport', 'leaving duplicate topic "realtime:watch-party:PRIVATE_ID"', privateData);
  trace.logger('transport', 'close', {code: 1006, reason: 'SECRET_SENTINEL'});
  trace.logger('receive', 'realtime:watch-party:PRIVATE_ID broadcast (10)', privateData);
  trace.logger('receive', 'phx_close realtime:watch-party:PRIVATE_ID broadcast (11)', privateData);
  trace.logger('transport', 'connected to wss://private.example.test?apikey=SECRET_SENTINEL');
  assert.deepEqual(trace.events.map(e => e.event), ['server_channel_close', 'client_channel_leave', 'duplicate_topic', 'socket_close']);
  assert.equal(trace.events.at(-1).closeCode, 1006);
  assert.ok(trace.events.every(e => Number.isFinite(e.at)));
  assert.ok(!JSON.stringify(trace.events).includes('SECRET_SENTINEL'));
  assert.ok(!JSON.stringify(trace.events).includes('PRIVATE_ID'));
});

test('trace stays bounded and never records an arbitrary close reason/code', () => {
  const trace = createRealtimeTrace();
  for (let i = 0; i < 30; i++) trace.logger('transport', 'close', {code: 'PRIVATE_CODE', reason: 'PRIVATE_REASON'});
  assert.equal(trace.events.length, 20);
  assert.ok(trace.events.every(event => event.closeCode === null));
  assert.ok(!JSON.stringify(trace.events).includes('PRIVATE_'));
});

test('trace categorizes server failures preceding phx_close without logging private details', () => {
  const trace = createRealtimeTrace();
  for (const [message, expected] of [
    ['Client presence rate limit exceeded', 'client_presence_limit'],
    ['Too many presence messages per second', 'project_presence_limit'],
    ['Too many messages per second', 'project_event_limit'],
    ['Token has expired', 'auth_token'],
    ['Server requested disconnect', 'server_disconnect'],
    ['Track message size exceeded', 'presence_size'],
  ]) {
    trace.logger('receive', 'error realtime:watch-party:PRIVATE_ID system (8)', {
      status: 'error', extension: 'system', message: message + ' SECRET_SENTINEL',
    });
    assert.equal(trace.events.at(-1).reason, expected);
  }
  trace.logger('receive', 'error realtime:watch-party:PRIVATE_ID phx_reply (9)', {
    status: 'error', response: {reason: 'ClientJoinRateLimitReached: SECRET_SENTINEL'},
  });
  assert.equal(trace.events.at(-1).reason, 'rate_limited');
  trace.logger('receive', 'realtime:watch-party:PRIVATE_ID phx_error', {});
  trace.logger('receive', 'realtime:watch-party:PRIVATE_ID phx_close (10)', {});
  assert.deepEqual(trace.events.slice(-3).map(e => e.event), ['phx_reply', 'phx_error', 'server_channel_close']);
  assert.ok(!/PRIVATE_ID|SECRET_SENTINEL/.test(JSON.stringify(trace.events)));
});
