import {mediaKey, validPlayback, isNewerPlayback} from './protocol.js';
import {LINK_PROTOCOL, parseSharedSource} from './shared-source.js';

export async function callRpc(client, name, args = {}) {
  const {data, error} = await client.rpc(name, args);
  if (error) throw error;
  const result = typeof data === 'string' && /^[\[{]/.test(data) ? JSON.parse(data) : data;
  if (result?.error) throw Object.assign(new Error(result.error), {code: result.error});
  return result;
}

// Fork command protocol 1 (Nuvio Desktop fork ≥ 0.1.39 as host): the host
// announces it in its status and is the only sequencer. Guests send commands
// with their own ID and never assign revisions themselves.
export const COMMAND_PROTOCOL = 1;
// Technical timeout for a missing host answer; never a lock on new commands.
export const ACK_TIMEOUT_MS = 4000;
const COMMAND_TRANSMISSIONS = 2; // first send + one retry with the same ID
const COMMAND_LIMIT = 64;
// 'superseded' is only sent by 0.1.39 hosts; later hosts order by arrival.
const REJECT_REASONS = ['host_only', 'superseded', 'stale_epoch', 'not_member', 'invalid'];
// pending → accepted → applied; pending/unknown → accepted/applied/rejected.
const NEXT_STATUS = {pending: ['accepted', 'applied', 'rejected', 'unknown'], unknown: ['accepted', 'applied', 'rejected'], accepted: ['applied'], applied: [], rejected: []};
const newCommandId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
// realtime-js drops a CLOSED channel for good (RealtimeChannel removes itself
// from the socket) and retries CHANNEL_ERROR/TIMED_OUT on its own. A closed or
// still-failing channel is therefore recreated here with bounded backoff.
export const REJOIN_GRACE_MS = 10000;
const RECONNECT_MAX_MS = 30000;
const CONNECTION_LOG_LIMIT = 20;
// Fixed categories only: realtime error texts may echo tokens or topics.
export function connectionReason(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  if (!text) return null;
  if (/jwt|token|expired/.test(text)) return 'auth_token';
  if (/unauthori[sz]ed|permission|denied|forbidden|policy|rls/.test(text)) return 'not_authorized';
  if (/rate|too many|limit/.test(text)) return 'rate_limited';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/network|socket|disconnect|closed|offline/.test(text)) return 'network';
  return 'other';
}

// Uses only RPCs and channel events present in Nuvio Dev PartyApi/PartyChannel.
// Guests never become coordinators. With host_only=false they control playback:
// via host-sequenced commands when the host supports them, otherwise like a
// Nuvio Desktop guest (broadcast, then persist) or after watch_party_update.
export class PartySession {
  constructor(client, deviceId, handlers = {}) {
    this.client = client; this.deviceId = deviceId; this.handlers = handlers;
    this.room = null; this.channel = null; this.playback = null; this.generation = 0;
    this.chatCursor = null; this.chatBusy = null; this.refreshBusy = null;
    this.seenMessages = new Set(); this.timers = []; this.clockOffset = 0;
    this.presence = {status: 'browsing'};
    this.closing = null;
    this.hostCommands = false; this.commands = new Map(); this.latestCommand = null;
    // Separate video shared by the host (links protocol 1). While it is set,
    // this.playback is the link's own timeline, never the film's.
    this.sharedSource = null; this.hostLinks = false;
    this.commandTimers = new Set(); this.ackTimeoutMs = ACK_TIMEOUT_MS;
    // Latest informational status/position report per member (display only).
    this.memberStatus = new Map(); this.positionProvider = null;
    this.reconnectTimer = null; this.reconnectAttempts = 0; this.reconnecting = null; this.rejoinGraceMs = REJOIN_GRACE_MS; this.reconnectBaseMs = 1000;
    // Local, allowlisted telemetry only: never retain payloads, identities or URLs.
    this.diagnostics = {connection: 'CLOSED', realtimeStates: 0, snapshotStates: 0,
      lastRealtimeAt: null, lastAcceptedAt: null, acceptedSource: null,
      lastSource: null, lastDecision: null, candidateSeq: null, realtimeLatencyMs: null,
      commands: 0, lastCommandResult: null, reconnects: 0, connectionLog: []};
  }
  // Identity of everything that is currently played together: the shared
  // link's key while one is active, otherwise the film's media_key.
  activeMediaKey() { return this.sharedSource?.key || (this.room ? mediaKey(this.room.info.media) : ''); }
  // A new host source (or its end) starts a new epoch: the previous timeline,
  // its commands and status reports never apply to the next player.
  applySharedSource(raw) {
    const room = this.room;
    if (!room) return;
    const next = raw == null ? null : parseSharedSource(raw, mediaKey(room.info.media));
    if (raw != null && !next) return; // Malformed or for another film: ignored.
    if ((next?.key ?? null) === (this.sharedSource?.key ?? null)) return; // Re-sent unchanged.
    this.sharedSource = next;
    this.playback = null;
    this.dropCommands('stale_epoch');
    this.memberStatus.clear(); this.emit('members', this.memberStatus);
    this.presence = {status: 'browsing'};
    this.emit('sharedSource', next);
    this.requestState().catch(() => {});
  }
  // Authoritative DB snapshot only (join/heartbeat); never a broadcast claim.
  canControl() {
    const room = this.room;
    return !!room && !!this.channel && room.info.host_only === false && !!room.info.host_member_id && room.info.host_member_id !== room.memberId;
  }
  prepareControl({paused, positionMs}) {
    const room = this.room;
    if (!this.canControl()) throw Object.assign(new Error('host_only'), {code: 'host_only'});
    // A shared link is steered only through the host's sequencer, never persisted.
    if (this.sharedSource) throw Object.assign(new Error('no_sequencer'), {code: 'no_sequencer'});
    const base = this.playback;
    const next = {seq: (base?.seq ?? 0) + 1, member_id: room.memberId, paused: paused === true,
      position_ms: Math.max(0, Math.round(Number(positionMs) || 0)), rate: base?.rate ?? 1,
      at: Math.round(this.now()), media_key: mediaKey(room.info.media), waiting: false};
    if (!validPlayback(next) || !next.media_key) throw Object.assign(new Error('invalid_command'), {code: 'invalid_command'});
    return {room, gen: this.generation, playback: next};
  }
  // mode 'desktop': same order and trust model as Nuvio Desktop guests
  // (PartyRepository.publish → state broadcast, then watch_party_update).
  // mode 'confirmed': persist first; distribute only the state the server
  // returned for exactly this member and sequence.
  async commitControl(command, {mode = 'confirmed'} = {}) {
    const {room, gen, playback} = command;
    const d = this.diagnostics;
    d.commands++;
    try {
      if (gen !== this.generation || room !== this.room) throw Object.assign(new Error('closed'), {code: 'closed'});
      if (mode === 'desktop') return await this.publishLikeDesktop(room, gen, playback);
      const result = await this.rpc('watch_party_update', {p_party_id: room.info.id, p_device_id: this.deviceId, p_playback: playback});
      if (gen !== this.generation || room !== this.room) throw Object.assign(new Error('closed'), {code: 'closed'});
      const party = result?.party, stored = party?.playback;
      if (party && party.host_only !== room.info.host_only) { room.info.host_only = party.host_only === true; this.emit('room', room); }
      if (party?.host_only !== false) throw Object.assign(new Error('host_only'), {code: 'host_only'});
      if (!stored || stored.seq !== playback.seq || stored.member_id !== room.memberId || stored.paused !== playback.paused ||
          mediaKey(party.media) !== playback.media_key) throw Object.assign(new Error('not_confirmed'), {code: 'not_confirmed'});
      this.acceptPlayback(stored, 'command');
      const sent = await this.channel?.send({type: 'broadcast', event: 'state', payload: stored});
      d.lastCommandResult = sent && sent !== 'ok' ? 'stored_not_broadcast' : 'confirmed';
      return stored;
    } catch (e) {
      d.lastCommandResult = ['host_only', 'not_confirmed', 'closed', 'broadcast_failed'].includes(e?.code) ? e.code : 'rpc_failed';
      throw e;
    }
  }
  async publishLikeDesktop(room, gen, playback) {
    const d = this.diagnostics;
    const sent = await this.channel?.send({type: 'broadcast', event: 'state', payload: playback});
    if (!this.channel || (sent && sent !== 'ok')) throw Object.assign(new Error('broadcast_failed'), {code: 'broadcast_failed'});
    if (gen !== this.generation || room !== this.room) throw Object.assign(new Error('closed'), {code: 'closed'});
    this.acceptPlayback(playback, 'command');
    d.lastCommandResult = 'broadcast';
    // Persist in the background like Desktop's schedulePersist: the command is
    // already distributed, so the next gesture must not wait for this RPC.
    this.persistControl(room, gen, playback);
    return playback;
  }
  // A failure does not revert the distributed state; a late or stale reply is
  // applied with normal ordering (acceptPlayback) and cannot roll back newer ones.
  async persistControl(room, gen, playback) {
    const d = this.diagnostics;
    try {
      const result = await this.rpc('watch_party_update', {p_party_id: room.info.id, p_device_id: this.deviceId, p_playback: playback});
      if (gen !== this.generation || room !== this.room) return;
      const party = result?.party;
      if (party && typeof party.host_only === 'boolean' && party.host_only !== room.info.host_only) { room.info.host_only = party.host_only; this.emit('room', room); }
      if (party?.playback) this.acceptPlayback(party.playback, 'snapshot');
      if (this.playback === playback || this.playback?.seq === playback.seq) d.lastCommandResult = 'persisted';
    } catch { if (gen === this.generation) d.lastCommandResult = 'persist_failed'; }
  }

  // --- Host-sequenced commands (protocol 1) ---------------------------------
  // PENDING: sent. ACCEPTED: the host (member_id = host_member_id) ordered it,
  // via ack or the resulting state. APPLIED: the host's player reached it
  // (informational only, never changes playback). REJECTED: host refused it.
  // UNKNOWN: no answer after one retry with the same ID; the server snapshot
  // is then reloaded. Realtime payload identities are not server-verified,
  // so acknowledgements only steer this UI; playback always follows the
  // ordered party state.
  canSequence() { return this.canControl() && this.hostCommands === true; }
  issueCommand({paused, positionMs, kind = 'toggle'}) {
    const room = this.room;
    if (!this.canControl()) throw Object.assign(new Error('host_only'), {code: 'host_only'});
    if (!this.hostCommands) throw Object.assign(new Error('no_sequencer'), {code: 'no_sequencer'});
    const base = this.playback, id = newCommandId();
    const command = {command_id: id, member_id: room.memberId, paused: paused === true,
      position_ms: Math.max(0, Math.round(Number(positionMs) || 0)), base_seq: base?.seq ?? null,
      media_key: this.activeMediaKey(), host_member_id: room.info.host_member_id};
    if (!command.media_key || !Number.isSafeInteger(command.position_ms)) throw Object.assign(new Error('invalid_command'), {code: 'invalid_command'});
    // Local preview while the host has not answered; never broadcast.
    const optimistic = {seq: base?.seq ?? 0, member_id: room.memberId, paused: command.paused, position_ms: command.position_ms,
      rate: base?.rate ?? 1, at: Math.round(this.now()), media_key: command.media_key, waiting: false};
    const entry = {id, kind, command, optimistic, room, gen: this.generation, status: 'pending', reason: null, seq: null,
      transmissions: 0, reached: false, stale: false};
    this.commands.set(id, entry);
    for (const [key, old] of this.commands) {
      if (this.commands.size <= COMMAND_LIMIT) break;
      if (old !== entry) this.commands.delete(key);
    }
    this.latestCommand = entry;
    this.diagnostics.commands++;
    this.transmit(entry);
    return entry;
  }
  async transmit(entry) {
    if (!this.commandLive(entry)) return;
    entry.transmissions++;
    // A failed send is answered by the same timeout and retry as a lost one.
    await Promise.resolve(this.channel?.send({type: 'broadcast', event: 'command', payload: entry.command})).catch(() => 'error');
    if (!this.commandLive(entry) || entry.status !== 'pending') return;
    this.later(() => {
      if (!this.commandLive(entry) || entry.status !== 'pending') return;
      if (entry.transmissions < COMMAND_TRANSMISSIONS) { this.transmit(entry); return; } // same ID: executed at most once
      this.settleCommand(entry, 'unknown');
      this.refresh(); // authoritative server state instead of repeating the command
    });
  }
  commandLive(entry) { return entry.gen === this.generation && entry.room === this.room; }
  later(callback) {
    const timer = setTimeout(() => { this.commandTimers.delete(timer); callback(); }, this.ackTimeoutMs);
    timer?.unref?.(); // Node test runs only; browsers return a number.
    this.commandTimers.add(timer);
  }
  settleCommand(entry, status, {seq = null, reason = null} = {}) {
    if (!NEXT_STATUS[entry.status].includes(status)) return;
    entry.status = status;
    if (Number.isSafeInteger(seq)) entry.seq = seq;
    if (status === 'rejected') entry.reason = REJECT_REASONS.includes(reason) ? reason : 'rejected';
    this.diagnostics.lastCommandResult = status;
    if (status === 'accepted' && !entry.reached) {
      // The ordered state itself may have been lost: ask for it, and stop
      // showing the local preview if it still does not arrive.
      if (entry.seq != null && (!this.playback || entry.seq > this.playback.seq)) this.requestState().catch(() => {});
      this.later(() => {
        if (!this.commandLive(entry) || entry.reached) return;
        entry.stale = true; this.emit('command', entry); this.refresh();
      });
    }
    this.emit('command', entry);
  }
  receiveAck(ack) {
    const room = this.room;
    if (!room || !ack || ack.member_id !== room.info.host_member_id || ack.origin_member_id !== room.memberId) return;
    const entry = this.commands.get(String(ack.command_id ?? ''));
    if (!entry || !this.commandLive(entry)) return;
    const seq = Number.isSafeInteger(ack.seq) ? ack.seq : null;
    if (ack.status === 'accepted') this.settleCommand(entry, 'accepted', {seq});
    else if (ack.status === 'applied' && (entry.seq == null || seq === entry.seq)) {
      if (entry.status !== 'accepted') this.settleCommand(entry, 'accepted', {seq});
      this.settleCommand(entry, 'applied', {seq});
    }
    else if (ack.status === 'rejected') {
      this.settleCommand(entry, 'rejected', {reason: ack.reason});
      // The host's revision is newer than ours: fetch it instead of falling
      // back to a stale local party state.
      if (seq != null && (!this.playback || seq > this.playback.seq)) { this.requestState().catch(() => {}); this.refresh(); }
    }
  }
  // The guest's own preview, as long as no other member's newer revision
  // superseded it. The guest's own earlier commands do not end the preview
  // (rapid toggling); the host orders them before this one.
  optimisticPlayback() {
    const entry = this.latestCommand, party = this.playback, room = this.room;
    if (!entry || !room || !this.commandLive(entry) || entry.reached || entry.stale || !['pending', 'accepted'].includes(entry.status)) return null;
    if (party && party.seq > (entry.command.base_seq ?? -1)) {
      const ownEarlier = party.origin_member_id === room.memberId && this.commands.has(party.command_id);
      if (!ownEarlier) return null;
    }
    return entry.optimistic;
  }
  dropCommands(reason) {
    for (const entry of this.commands.values()) if (['pending', 'unknown'].includes(entry.status)) this.settleCommand(entry, 'rejected', {reason});
    this.commandTimers.forEach(clearTimeout); this.commandTimers.clear();
    this.commands.clear(); this.latestCommand = null;
  }

  rpc(name, args) { return callRpc(this.client, name, args); }
  emit(name, ...values) { this.handlers[name]?.(...values); }
  now() { return Date.now() + this.clockOffset; }
  // allowAnonymous is only passed by builds whose backend authorizes anonymous
  // Supabase members server-side; the server remains the authority.
  async join(code, displayName, profileIndex, {allowAnonymous = false} = {}) {
    await this.close();
    const gen = ++this.generation;
    const {data: {session}, error} = await this.client.auth.getSession();
    if (error) throw error;
    if (!session?.user || (session.user.is_anonymous && !allowAnonymous)) throw new Error('Ein angemeldetes, nicht anonymes Nuvio-Konto ist erforderlich.');
    if (gen !== this.generation) return;
    const args = {p_code: code, p_device_id: this.deviceId, p_display_name: displayName.slice(0, 40), p_avatar_url: null, p_avatar_color: null};
    let snapshot;
    const sent = Date.now();
    try {
      snapshot = await this.rpc('watch_party_join', profileIndex == null ? args : {...args, p_profile_index: profileIndex});
    } catch (e) {
      // Exactly the same backward compatibility as PartyApi.callWithProfile.
      if (e.code !== 'PGRST202' || profileIndex == null) throw e;
      snapshot = await this.rpc('watch_party_join', args);
    }
    if (gen !== this.generation) return;
    if (!snapshot?.party || !snapshot.member_id) throw new Error('Ungültige Party-Antwort ohne Party/Mitglied.');
    this.room = {info: snapshot.party, memberId: snapshot.member_id, members: snapshot.members || []};
    if (Number.isFinite(snapshot.server_time_ms)) this.clockOffset = snapshot.server_time_ms - (sent + Date.now()) / 2;
    this.emit('room', this.room);
    this.acceptPlayback(snapshot.party.playback, 'snapshot');
    try {
      await this.client.realtime.setAuth(session.access_token);
      if (gen !== this.generation) return;
      this.attachRealtime(gen);
      this.timers = [setInterval(() => this.refresh(), 45000), setInterval(() => this.loadMessages(), 5000), setInterval(() => this.syncClock(), 60000)];
      await Promise.all([this.syncClock(), this.loadMessages()]);
    } catch (e) { if (gen === this.generation) await this.close(); throw e; }
  }
  attachRealtime(gen) {
    const room = this.room;
    const ch = this.client.channel(`watch-party:${room.info.id}`, {
      config: {private: true, broadcast: {ack: false, self: false}, presence: {key: room.memberId}},
    });
    this.channel = ch;
    this.noteConnection('CONNECTING');
    this.emit('connection', 'CONNECTING');
    for (const event of ['state', 'stream', 'media', 'control', 'chat', 'ended', 'member_left', 'member_joined', 'state_request', 'status', 'ack', 'countdown', 'shared_source', 'stream_suggest_result']) {
      ch.on('broadcast', {event}, ({payload}) => {
        if (gen === this.generation && this.room === room && this.channel === ch) this.receive(event, payload);
      });
    }
    ch.subscribe(async (state, error) => {
      // Callbacks of a replaced or removed channel are stale.
      if (gen !== this.generation || this.channel !== ch) return;
      this.noteConnection(state, error);
      this.emit('connection', state);
      if (error) this.emit('error', new Error('Privater Realtime-Kanal nicht verbunden. Anmeldung und Netzwerk prüfen.'));
      if (state !== 'SUBSCRIBED') { this.scheduleReconnect(gen, state); return; }
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      try { await Promise.all([this.sendPresence(), this.requestState(), this.refresh()]); }
      catch (e) { this.emit('error', e); }
    });
  }
  // Status changes with fixed reason categories and timestamps; never the
  // error text, tokens, topics or URLs.
  noteConnection(state, error) {
    const d = this.diagnostics;
    d.connection = ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state) ? state : 'CONNECTING';
    d.connectionLog.push({at: new Date().toISOString(), state: d.connection, reason: connectionReason(error)});
    if (d.connectionLog.length > CONNECTION_LOG_LIMIT) d.connectionLog.shift();
  }
  // CLOSED is final in realtime-js: recreate after a short backoff. For
  // CHANNEL_ERROR/TIMED_OUT realtime-js rejoins itself; recreate only if that
  // did not succeed within the grace period.
  scheduleReconnect(gen, state) {
    if (this.reconnectTimer || this.reconnecting) return;
    const backoff = Math.min(RECONNECT_MAX_MS, this.reconnectBaseMs * 2 ** this.reconnectAttempts);
    const delay = state === 'CLOSED' ? backoff : Math.max(this.rejoinGraceMs, backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen === this.generation && this.room && this.diagnostics.connection !== 'SUBSCRIBED') this.reconnect();
    }, delay);
    this.reconnectTimer?.unref?.(); // Node test runs only.
  }
  // Fresh channel and token (getSession refreshes an expired session). Also
  // used by the refresh button when the connection is lost.
  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    const room = this.room, gen = this.generation, old = this.channel;
    if (!room) return Promise.resolve();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.diagnostics.reconnects++;
    this.reconnectAttempts++;
    this.channel = null; // Silences the old channel's callbacks before removal.
    this.reconnecting = (async () => {
      try {
        if (old) await this.client.removeChannel(old).catch(() => {});
        const {data: {session} = {}, error} = await this.client.auth.getSession();
        if (gen !== this.generation || room !== this.room) return;
        if (error || !session?.access_token) {
          this.noteConnection('CLOSED', error || new Error('token'));
          this.emit('connection', 'CLOSED');
          this.emit('error', new Error('Nuvio-Anmeldung abgelaufen. Bitte neu anmelden, um die Party-Verbindung wiederherzustellen.'));
          return;
        }
        await this.client.realtime.setAuth(session.access_token);
        if (gen !== this.generation || room !== this.room) return;
        this.attachRealtime(gen);
      } catch (e) {
        if (gen === this.generation && room === this.room) { this.emit('error', e); this.scheduleReconnect(gen, 'CLOSED'); }
      } finally { this.reconnecting = null; }
    })();
    return this.reconnecting;
  }
  receive(event, payload) {
    if (event === 'state') { this.acceptPlayback(payload, 'realtime'); return; }
    if (!this.room || !payload) return;
    if (event === 'ack') { this.receiveAck(payload); return; }
    // Only the current host's status announces the sequencer capability.
    if (event === 'status') {
      if (payload.member_id === this.room.info.host_member_id) {
        this.hostCommands = payload.commands === COMMAND_PROTOCOL;
        const links = payload.links === LINK_PROTOCOL;
        if (links !== this.hostLinks) { this.hostLinks = links; this.emit('room', this.room); }
      }
      this.noteMemberStatus(payload);
      return;
    }
    if (event === 'stream' && payload.member_id === this.room.info.host_member_id) this.emit('stream', payload.stream ?? null);
    // Only the current host shares or ends a separate video, and only for this film.
    if (event === 'shared_source' && payload.member_id === this.room.info.host_member_id &&
        payload.media_key === mediaKey(this.room.info.media)) this.applySharedSource(payload.source ?? null);
    // Host decision about this member's own proposal (display only).
    if (event === 'stream_suggest_result' && payload.member_id === this.room.info.host_member_id &&
        payload.target_member_id === this.room.memberId && ['accepted', 'declined'].includes(payload.status)) this.emit('suggestResult', payload.status);
    // Shared start announced by the host (server time); display only.
    if (event === 'countdown' && payload.member_id === this.room.info.host_member_id) this.emit('countdown', payload);
    // Database snapshots are authoritative for media, membership and host-only changes.
    if (['media', 'control', 'member_joined'].includes(event)) this.refresh();
    if (event === 'chat') this.loadMessages();
    if (event === 'state_request' && payload.member_id !== this.room.memberId) this.sendPresence().catch(e => this.emit('error', e));
    if (event === 'ended' || event === 'member_left') this.refresh();
  }
  acceptPlayback(next, source = 'snapshot') {
    source = ['realtime', 'command'].includes(source) ? source : 'snapshot';
    const d = this.diagnostics, receivedAt = Date.now();
    if (source === 'realtime') {
      d.realtimeStates++; d.lastRealtimeAt = receivedAt;
      // Publish-to-receive delay in server time; separates network latency
      // from video buffering. Clock offset error is included.
      const latency = this.now() - Number(next?.at);
      d.realtimeLatencyMs = Number.isFinite(latency) && Math.abs(latency) < 60000 ? Math.round(latency) : null;
    }
    else d.snapshotStates++;
    d.lastSource = source;
    d.candidateSeq = Number.isSafeInteger(next?.seq) ? next.seq : null;
    const info = this.room?.info;
    const link = this.sharedSource;
    d.lastDecision = !info ? 'no_room' : !validPlayback(next) ? 'invalid_playback'
      // A shared link only follows its own key; the film's states (and states
      // without a key) wait until the host ends the link.
      : link ? (next.media_key !== link.key ? 'wrong_media' : next.member_id !== info.host_member_id ? 'not_host' : null)
      : next.media_key && next.media_key !== mediaKey(info.media) ? 'wrong_media' : null;
    d.lastDecision = d.lastDecision ?? (info.host_only && next.member_id !== info.host_member_id ? 'not_host'
      : !isNewerPlayback(next, this.playback) ? 'not_newer' : 'accepted');
    if (d.lastDecision !== 'accepted') return;
    d.lastAcceptedAt = receivedAt; d.acceptedSource = source;
    this.playback = next;
    // The ordered revision of one of our commands, published by the host.
    const entry = next.command_id && next.origin_member_id === this.room.memberId && next.member_id === info.host_member_id
      ? this.commands.get(String(next.command_id)) : null;
    if (entry && this.commandLive(entry)) {
      entry.reached = true;
      if (entry.status === 'pending' || entry.status === 'unknown') this.settleCommand(entry, 'accepted', {seq: next.seq});
    }
    this.emit('playback', next);
  }
  async refresh() {
    const room = this.room;
    if (!room || this.refreshBusy === room) return;
    this.refreshBusy = room;
    try {
      const result = await this.rpc('watch_party_heartbeat', {p_party_id: room.info.id, p_device_id: this.deviceId});
      if (room !== this.room) return;
      if (!result?.party) return await this.finish('Die Party wurde beendet.', 'ended');
      const changed = mediaKey(room.info.media) !== mediaKey(result.party.media);
      const hostChanged = room.info.host_member_id !== result.party.host_member_id;
      room.info = result.party; room.members = result.members || [];
      // Sequence numbers belong to a coordinator. A new host may start at 0;
      // never keep following the previous host while waiting for its state.
      if (changed || hostChanged) this.playback = null;
      // New epoch: commands for the previous host or film never become valid.
      if (hostChanged) this.hostCommands = false;
      if (changed || hostChanged) this.dropCommands('stale_epoch');
      if (changed) { this.memberStatus.clear(); this.emit('members', this.memberStatus); }
      if (changed) { this.presence = {status: 'browsing'}; this.emit('media', room.info.media); }
      // A shared link belongs to its film and its host; a new host announces its own.
      if ((changed || hostChanged) && this.sharedSource) { this.sharedSource = null; this.emit('sharedSource', null); }
      if (hostChanged) this.hostLinks = false;
      // A host change is not a revocation by the sharing host; main decides
      // whether an already loaded source may continue locally.
      if (changed || hostChanged) this.emit('stream', null, changed ? 'media_changed' : 'host_changed');
      if (room.info.host_member_id === room.memberId) {
        // This guest cannot provide media/coordinator duties if a backend promotes it.
        return await this.finish('Der Desktop-Host hat die Party verlassen. Bitte eine neue Desktop-Party öffnen.', 'host_left');
      }
      this.emit('room', room); this.acceptPlayback(result.party.playback, 'snapshot');
      if (changed || hostChanged) { await this.sendPresence(); await this.requestState(); }
    } catch (e) {
      if (room !== this.room) return;
      if (['not_member', 'removed'].includes(e.code)) await this.finish('Deine Mitgliedschaft in der Party wurde entfernt.', 'removed');
      else if (['party_ended', 'party_not_found', 'unavailable'].includes(e.code)) await this.finish('Die Party ist beendet.', 'ended');
      else this.emit('error', e);
    } finally { if (this.refreshBusy === room) this.refreshBusy = null; }
  }
  async syncClock() {
    const room = this.room, sent = Date.now();
    try {
      const time = Number(await this.rpc('watch_party_clock'));
      if (room && room === this.room && Number.isFinite(time)) this.clockOffset = time - (sent + Date.now()) / 2;
    } catch (e) { if (room === this.room) this.emit('error', new Error('Serverzeit nicht aktualisierbar; Synchronisierung kann abweichen.')); }
  }
  // Allowlisted numbers/labels only; a report never changes playback.
  noteMemberStatus(payload) {
    const room = this.room, id = String(payload?.member_id ?? '');
    if (!room || !id || id === room.memberId || !room.members.some(m => m.id === id)) return;
    if (payload.media_key && payload.media_key !== this.activeMediaKey()) { this.memberStatus.delete(id); return; }
    const number = v => Number.isFinite(v) ? v : undefined;
    this.memberStatus.set(id, {status: ['browsing', 'loading', 'buffering', 'ready', 'behind'].includes(payload.status) ? payload.status : 'browsing',
      media_key: payload.media_key, position_ms: number(payload.position_ms), position_at: number(payload.position_at), playing: payload.playing === true});
    this.emit('members', this.memberStatus);
  }
  positionFields() {
    const position = this.positionProvider?.();
    if (!position || !Number.isFinite(position.position_ms)) return {};
    return {position_ms: Math.max(0, Math.round(position.position_ms)), position_at: Math.round(this.now()), playing: position.playing === true};
  }
  // Sparse position report (main calls it about every 10 s); status event only.
  async reportPosition() {
    if (!this.room || !this.channel) return;
    const fields = this.positionFields();
    if (!('position_ms' in fields)) return;
    const payload = {...this.presence, member_id: this.room.memberId, media_key: this.activeMediaKey(), ...fields};
    await this.channel.send({type: 'broadcast', event: 'status', payload}).catch(() => {});
  }
  async sendPresence(status, behindMs, solo = false) {
    if (!this.room || !this.channel) return;
    // solo: watching alone on purpose (shown as "Allein"); optional field.
    if (status) this.presence = {status, ...(behindMs != null ? {behind_ms: behindMs} : {}), ...(solo ? {solo: true} : {})};
    // While a shared link plays, reports carry its key: the Desktop host never
    // pauses the film for a member who is buffering the link.
    const payload = {...this.presence, member_id: this.room.memberId, media_key: this.activeMediaKey(), ...this.positionFields()};
    const tracked = await this.channel.track(payload);
    if (tracked && tracked !== 'ok') throw new Error('Online-Status nicht bestätigt (' + tracked + '). RPC-Beitritt allein stellt keine Realtime-Verbindung her.');
    const sent = await this.channel.send({type: 'broadcast', event: 'status', payload});
    if (sent && sent !== 'ok') throw new Error('Party-Status nicht gesendet (' + sent + ').');
  }
  // Proposal of a video link to the Desktop host (explicit opt-in per link).
  // Never applied by the sender: the host must confirm, and the host's checked
  // stream event is what guests then play.
  // fields: optional {kind, video_id} (shared-source.js suggestionFields) for a
  // separate YouTube/MP4/WebM video; older hosts only know HLS proposals.
  async suggestStream(url, key, fields = {}) {
    if (!this.room || !this.channel) throw new Error('Keine Party-Verbindung.');
    const extra = {};
    if (typeof fields.kind === 'string') extra.kind = fields.kind;
    if (typeof fields.video_id === 'string') extra.video_id = fields.video_id;
    const result = await this.channel.send({type: 'broadcast', event: 'stream_suggest', payload: {member_id: this.room.memberId, media_key: key, url, ...extra}});
    if (result && result !== 'ok') throw new Error('Vorschlag nicht gesendet (' + result + ').');
  }
  async requestState() {
    if (this.room && this.channel) {
      const result = await this.channel.send({type: 'broadcast', event: 'state_request', payload: {member_id: this.room.memberId}});
      if (result && result !== 'ok') throw new Error('Streamanfrage nicht gesendet (' + result + ').');
    }
  }
  async loadMessages() {
    const room = this.room;
    if (!room || this.chatBusy === room) return;
    this.chatBusy = room;
    try {
      const args = {p_party_id: room.info.id, p_device_id: this.deviceId};
      if (this.chatCursor != null) args.p_after = this.chatCursor;
      const result = await this.rpc('watch_party_list_messages', args);
      if (room !== this.room) return;
      for (const message of result?.messages || []) {
        if (!/^\d+$/.test(String(message.id))) continue;
        const id = String(message.id);
        if (this.seenMessages.has(id)) continue;
        this.seenMessages.add(id);
        if (this.seenMessages.size > 500) this.seenMessages.delete(this.seenMessages.values().next().value);
        if (this.chatCursor == null || BigInt(id) > BigInt(this.chatCursor)) this.chatCursor = id;
        this.emit('chat', message);
      }
    } catch (e) { if (room === this.room) this.emit('error', new Error('Chat konnte nicht geladen werden: ' + e.message)); }
    finally { if (this.chatBusy === room) this.chatBusy = null; }
  }
  async sendMessage(body, clientId) {
    const room = this.room;
    if (!room) return;
    await this.rpc('watch_party_send_message', {p_party_id: room.info.id, p_device_id: this.deviceId, p_body: body, p_client_id: clientId});
    if (room === this.room) await this.loadMessages();
  }
  // reason: 'ended' | 'host_left' | 'removed'. Passed to "closed" and "ended"
  // so the page can keep an already loaded source locally after a party end;
  // a removal or an explicit leave/join always stops it.
  async finish(message, reason = 'ended') {
    if (!this.room) return;
    this.finishReason = reason;
    const closing = this.close(false), gen = this.generation;
    this.finishReason = null;
    await closing;
    // An explicit close or a newer join supersedes this end notification.
    if (gen === this.generation && !this.room) this.emit('ended', message, reason);
  }
  close(callLeave = true) {
    this.generation++; // Also cancel joins still awaiting authentication/RPC.
    if (this.closing) return this.closing;
    const old = this.room, ch = this.channel;
    this.room = null; this.channel = null; this.playback = null;
    this.hostCommands = false; this.commands.clear(); this.latestCommand = null; this.memberStatus.clear();
    this.sharedSource = null; this.hostLinks = false;
    this.commandTimers.forEach(clearTimeout); this.commandTimers.clear();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectAttempts = 0;
    this.diagnostics.connection = 'CLOSED';
    this.timers.forEach(clearInterval); this.timers = [];
    this.chatCursor = null; this.seenMessages.clear(); this.presence = {status: 'browsing'};
    this.chatBusy = this.refreshBusy = null;
    // Share cleanup so a concurrent close/join cannot run past channel removal.
    // Install the promise before notifying handlers, which may close again.
    this.closing = Promise.resolve().then(async () => {
      if (ch) await this.client.removeChannel(ch).catch(() => {});
      if (old && callLeave) await this.rpc('watch_party_leave', {p_party_id: old.info.id, p_device_id: this.deviceId}).catch(() => this.emit('error', new Error('Austritt nicht bestätigt; die Mitgliedschaft läuft serverseitig aus.')));
    }).finally(() => { this.closing = null; });
    if (old || ch) this.emit('closed', this.finishReason ?? null);
    return this.closing;
  }
}
