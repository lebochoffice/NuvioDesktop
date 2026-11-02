import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {SYNC, HLS_TUNING, bufferedRanges, bufferAhead, correctionFor, seekTarget, SeekLead, StallTracker, qualityOptions} from '../src/sync-policy.js';

const ranges = list => ({length: list.length, start: i => list[i][0], end: i => list[i][1]});

test('corrections mirror Desktop PartySync thresholds with nudge hysteresis', () => {
  assert.equal(correctionFor({drift: .4, paused: true, nudging: false}).kind, 'in_sync');
  assert.equal(correctionFor({drift: .6, paused: true, nudging: false}).kind, 'seek');
  assert.equal(correctionFor({drift: -1.6, paused: false, nudging: false}).kind, 'seek');
  assert.deepEqual(correctionFor({drift: -.3, paused: false, nudging: false}), {kind: 'nudge', rate: 1.05});
  assert.deepEqual(correctionFor({drift: .3, paused: false, nudging: false, rate: 2}), {kind: 'nudge', rate: 1.9});
  // Started nudge continues down to the stop threshold, but does not start below the start threshold.
  assert.equal(correctionFor({drift: -.15, paused: false, nudging: true}).kind, 'nudge');
  assert.equal(correctionFor({drift: -.15, paused: false, nudging: false}).kind, 'in_sync');
  assert.equal(correctionFor({drift: -.05, paused: false, nudging: true}).kind, 'in_sync');
});

test('seek targets land directly inside the buffer and ahead by the learned lead otherwise', () => {
  const buffered = bufferedRanges(ranges([[0, 30], [50, 60]]));
  assert.deepEqual(seekTarget({desired: 20, paused: false, ranges: buffered, leadS: 2, duration: 100}), {seconds: 20, buffered: true, leadS: 0});
  assert.deepEqual(seekTarget({desired: 40, paused: false, ranges: buffered, leadS: 2, duration: 100}), {seconds: 42, buffered: false, leadS: 2});
  assert.equal(seekTarget({desired: 40, paused: true, ranges: buffered, leadS: 2, duration: 100}).seconds, 40); // Paused: exact frame.
  assert.equal(seekTarget({desired: 40, paused: false, ranges: buffered, leadS: 99, duration: 100}).seconds, 40 + SYNC.maxLeadS);
  assert.equal(seekTarget({desired: 99.5, paused: false, ranges: [], leadS: 2, duration: 100}).seconds, 99.9);
  assert.equal(seekTarget({desired: 29.9, paused: false, ranges: buffered, leadS: 1, duration: 100}).buffered, false); // Too close to the buffer end.
  assert.equal(bufferAhead(buffered, 25), 5); assert.equal(bufferAhead(buffered, 40), 0);
  assert.deepEqual(bufferedRanges(undefined), []);
});

test('seek lead learns a bounded recovery delay and ignores implausible samples', () => {
  const lead = new SeekLead();
  lead.observe(2000); assert.equal(lead.seconds, 2);
  lead.observe(NaN); lead.observe(-5); lead.observe(60000); assert.equal(lead.samples, 1);
  lead.observe(10000); assert.equal(lead.seconds, 2 * .7 + SYNC.maxLeadS * .3);
  lead.reset(); assert.equal(lead.seconds, 0);
});

test('WLAN micro-stalls stay local; sustained stalls report buffering with hysteresis', () => {
  const t = new StallTracker();
  assert.equal(t.update(0, true), 'ready');
  assert.equal(t.update(2499, true), 'ready');
  assert.equal(t.update(2600, false), 'ready'); // Short stall never reached the party.
  assert.equal(t.update(3000, true), 'ready');
  assert.equal(t.update(5500, true), 'buffering');
  assert.equal(t.update(5600, false), 'buffering');
  assert.equal(t.update(6000, true), 'buffering'); // A relapse restarts the stable window.
  assert.equal(t.update(6100, false), 'buffering');
  assert.equal(t.update(6850, false), 'ready');
  assert.equal(t.stalls, 2);
});

test('mobile fairness: after the wait budget a guest catches up alone until the window expires', () => {
  const t = new StallTracker();
  let now = 0;
  const stall = () => { t.update(now, true); now += SYNC.stallReportMs; const state = t.update(now, true); t.update(now, false); now += SYNC.readyHoldMs; t.update(now, false); return state; };
  assert.equal(stall(), 'buffering'); assert.equal(stall(), 'buffering');
  assert.equal(stall(), 'behind'); assert.equal(t.selfCatchUp, false); // Reset after recovery.
  now += SYNC.waitWindowMs; assert.equal(stall(), 'buffering');
});

test('quality options list only real distinct variants; a single variant offers no choice', () => {
  assert.deepEqual(qualityOptions([{height: 1080, bitrate: 6e6}]), []);
  assert.deepEqual(qualityOptions([]), []); assert.deepEqual(qualityOptions(undefined), []);
  assert.deepEqual(qualityOptions([{height: 720, bitrate: 3e6}, {height: 2160, bitrate: 15e6}, {height: 1080, bitrate: 5e6}, {height: 1080, bitrate: 7e6}, {}]), [
    {value: -1, label: 'Auto'}, {value: 1, label: '4K'}, {value: 3, label: '1080p'}, {value: 0, label: '720p'}]);
  assert.deepEqual(qualityOptions([{height: 480}, {height: 360}]).map(o => o.label), ['Auto', '480p', '360p']);
});

test('hls.js tuning keeps ABR/forward-buffer defaults and only bounds back buffer memory', () => {
  assert.deepEqual(Object.keys(HLS_TUNING).sort(), ['backBufferLength', 'maxMaxBufferLength', 'startFragPrefetch']);
  assert.ok(!('capLevelToPlayerSize' in HLS_TUNING) && !('maxBufferLength' in HLS_TUNING));
});
