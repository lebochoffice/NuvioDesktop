import {mediaKey, validPlayback, isNewerPlayback} from './protocol.js';

export async function callRpc(client, name, args = {}) {
  const {data, error} = await client.rpc(name, args);
  if (error) throw error;
  const result = typeof data === 'string' && /^[\[{]/.test(data) ? JSON.parse(data) : data;
  if (result?.error) throw Object.assign(new Error(result.error), {code: result.error});
  return result;
}

// Uses only RPCs and channel events present in Nuvio Dev PartyApi/PartyChannel.
// Browser controls remain local; guests do not publish playback or become coordinators.
export class PartySession {
  constructor(client, deviceId, handlers = {}) {
    this.client = client; this.deviceId = deviceId; this.handlers = handlers;
    this.room = null; this.channel = null; this.playback = null; this.generation = 0;
    this.chatCursor = null; this.chatBusy = null; this.refreshBusy = null;
    this.seenMessages = new Set(); this.timers = []; this.clockOffset = 0;
    this.presence = {status: 'browsing'};
  }
  rpc(name, args) { return callRpc(this.client, name, args); }
  emit(name, value) { this.handlers[name]?.(value); }
  now() { return Date.now() + this.clockOffset; }
  async join(code, displayName, profileIndex) {
    await this.close();
    const gen = ++this.generation;
    const {data: {session}, error} = await this.client.auth.getSession();
    if (error) throw error;
    if (!session?.user || session.user.is_anonymous) throw new Error('Ein angemeldetes, nicht anonymes Nuvio-Konto ist erforderlich.');
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
    this.acceptPlayback(snapshot.party.playback);
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
    for (const event of ['state', 'stream', 'media', 'control', 'chat', 'ended', 'member_left', 'member_joined', 'state_request']) {
      ch.on('broadcast', {event}, ({payload}) => {
        if (gen === this.generation && this.room === room) this.receive(event, payload);
      });
    }
    ch.subscribe(async (state, error) => {
      if (gen !== this.generation) return;
      this.emit('connection', state);
      if (error) this.emit('error', new Error('Privater Realtime-Kanal: ' + (error.message || state)));
      if (state !== 'SUBSCRIBED') return;
      try { await Promise.all([this.sendPresence(), this.requestState(), this.refresh()]); }
      catch (e) { this.emit('error', e); }
    });
  }
  receive(event, payload) {
    if (!this.room || !payload) return;
    if (event === 'state') this.acceptPlayback(payload);
    if (event === 'stream' && payload.member_id === this.room.info.host_member_id) this.emit('stream', payload.stream ?? null);
    // Database snapshots are authoritative for media, membership and host-only changes.
    if (['media', 'control', 'member_joined'].includes(event)) this.refresh();
    if (event === 'chat') this.loadMessages();
    if (event === 'state_request' && payload.member_id !== this.room.memberId) this.sendPresence().catch(e => this.emit('error', e));
    if (event === 'ended' || event === 'member_left') this.refresh();
  }
  acceptPlayback(next) {
    if (!this.room || !validPlayback(next)) return;
    const info = this.room.info;
    if (next.media_key && next.media_key !== mediaKey(info.media)) return;
    if (info.host_only && next.member_id !== info.host_member_id) return;
    if (!isNewerPlayback(next, this.playback)) return;
    this.playback = next; this.emit('playback', next);
  }
  async refresh() {
    const room = this.room;
    if (!room || this.refreshBusy === room) return;
    this.refreshBusy = room;
    try {
      const result = await this.rpc('watch_party_heartbeat', {p_party_id: room.info.id, p_device_id: this.deviceId});
      if (room !== this.room) return;
      if (!result?.party) return await this.finish('Die Party wurde beendet.');
      const changed = mediaKey(room.info.media) !== mediaKey(result.party.media);
      const hostChanged = room.info.host_member_id !== result.party.host_member_id;
      room.info = result.party; room.members = result.members || [];
      if (changed) { this.playback = null; this.presence = {status: 'browsing'}; this.emit('media', room.info.media); }
      if (changed || hostChanged) this.emit('stream', null);
      if (room.info.host_member_id === room.memberId) {
        // This guest cannot provide media/coordinator duties if a backend promotes it.
        return await this.finish('Der Desktop-Host hat die Party verlassen. Bitte eine neue Desktop-Party öffnen.');
      }
      this.emit('room', room); this.acceptPlayback(result.party.playback);
      if (changed || hostChanged) { await this.sendPresence(); await this.requestState(); }
    } catch (e) {
      if (room !== this.room) return;
      if (['not_member', 'removed', 'party_ended', 'party_not_found', 'unavailable'].includes(e.code)) await this.finish('Die Party ist beendet oder deine Mitgliedschaft wurde entfernt.');
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
  async sendPresence(status, behindMs) {
    if (!this.room || !this.channel) return;
    if (status) this.presence = {status, ...(behindMs != null ? {behind_ms: behindMs} : {})};
    const payload = {...this.presence, member_id: this.room.memberId, media_key: mediaKey(this.room.info.media)};
    const tracked = await this.channel.track(payload);
    if (tracked && tracked !== 'ok') throw new Error('Online-Status nicht bestätigt (' + tracked + '). RPC-Beitritt allein stellt keine Realtime-Verbindung her.');
    const sent = await this.channel.send({type: 'broadcast', event: 'status', payload});
    if (sent && sent !== 'ok') throw new Error('Party-Status nicht gesendet (' + sent + ').');
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
  async finish(message) { await this.close(false); this.emit('ended', message); }
  async close(callLeave = true) {
    const old = this.room, ch = this.channel;
    this.generation++; this.room = null; this.channel = null; this.playback = null;
    this.timers.forEach(clearInterval); this.timers = [];
    this.chatCursor = null; this.seenMessages.clear(); this.presence = {status: 'browsing'};
    this.chatBusy = this.refreshBusy = null;
    this.emit('closed');
    if (ch) await this.client.removeChannel(ch).catch(() => {});
    if (old && callLeave) await this.rpc('watch_party_leave', {p_party_id: old.info.id, p_device_id: this.deviceId}).catch(e => this.emit('error', new Error('Austritt nicht bestätigt; die Mitgliedschaft läuft serverseitig aus.')));
  }
}
