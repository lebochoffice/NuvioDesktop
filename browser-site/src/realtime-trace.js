// Classify only protocol errors. Never retain the original text or payload.
export function realtimeFailureReason(payload) {
  const response = payload?.response;
  const message = [payload, payload?.message, payload?.reason, payload?.error, payload?.code,
    response?.message, response?.reason, response?.error, response?.code]
    .filter(value => typeof value === 'string').join(' ');
  if (/client presence rate limit exceeded/i.test(message)) return 'client_presence_limit';
  if (/too many presence messages per second/i.test(message)) return 'project_presence_limit';
  if (/too many messages per second|tenant_events/i.test(message)) return 'project_event_limit';
  if (/ratelimitreached|rate limit|too_many_(joins|connections|channels)/i.test(message)) return 'rate_limited';
  if (/track message size exceeded/i.test(message)) return 'presence_size';
  if (/presence track payload must be a map/i.test(message)) return 'presence_payload';
  if (/jwt|token has expired/i.test(message)) return 'auth_token';
  if (/unauthori[sz]ed|forbidden|permission denied/i.test(message)) return 'not_authorized';
  if (/server requested disconnect/i.test(message)) return 'server_disconnect';
  return 'other';
}

// Opt-in SDK logger. Never retain raw messages, payloads, topics or identifiers.
// Categories match the installed Phoenix logger; unknown formats are ignored.
export function createRealtimeTrace() {
  const events = [];
  return {events, logger(kind, message, data) {
    let event, closeCode = null, reason;
    if (kind === 'receive' && /(?:^|\s)realtime:watch-party:\S+\s+phx_close(?:\s+\([^)]*\))?\s*$/.test(message)) event = 'server_channel_close';
    else if (kind === 'push' && /^realtime:watch-party:\S+\s+phx_leave(?:\s+\([^)]*\))?\s*$/.test(message)) event = 'client_channel_leave';
    else if (kind === 'receive') {
      const frame = /(?:^|\s)realtime:watch-party:\S+\s+(system|phx_error|phx_reply)(?:\s+\([^)]*\))?\s*$/.exec(message)?.[1];
      if (!frame || (frame !== 'phx_error' && data?.status !== 'error')) return;
      event = frame;
      reason = realtimeFailureReason(data);
    } else if (kind === 'transport' && String(message).startsWith('leaving duplicate topic ')) event = 'duplicate_topic';
    else if (kind === 'transport' && message === 'close') {
      event = 'socket_close';
      if (Number.isInteger(data?.code) && data.code >= 1000 && data.code <= 4999) closeCode = data.code;
    } else if (kind === 'transport' && message === 'error') event = 'socket_error';
    if (!event) return;
    events.push({at: Date.now(), event, closeCode, ...(reason ? {reason} : {})});
    if (events.length > 20) events.shift();
  }};
}
