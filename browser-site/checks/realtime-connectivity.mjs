// Real, unauthenticated transport probe. Never reads stored login sessions.
// Opening a WebSocket is NOT proof that private party authorization works.
import {readFile} from 'node:fs/promises';
const config = Object.fromEntries((await readFile(new URL('../.env.local', import.meta.url), 'utf8')).split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const base = new URL(config.VITE_SUPABASE_URL);
const key = config.VITE_SUPABASE_ANON_KEY;
if (!key || !base.hostname || base.protocol !== 'https:') throw new Error('Public local configuration missing');
for (const marker of [false,true]) {
  const target = new URL('/realtime/v1/websocket', base); target.protocol = 'wss:';
  target.searchParams.set('apikey', key); target.searchParams.set('vsn','1.0.0');
  if (marker) target.searchParams.set('nuvio_realtime','1');
  const result = await new Promise(resolve => {
    const socket = new WebSocket(target);
    const timer = setTimeout(() => {socket.close(); resolve('timeout');},10000);
    socket.onopen = () => {clearTimeout(timer);socket.close();resolve('open');};
    socket.onerror = () => {clearTimeout(timer);resolve('failed');};
  });
  console.log(JSON.stringify({check:'websocket-handshake',nuvio_realtime:marker,result}));
}
const response = await fetch(new URL('/auth/v1/settings',base),{headers:{apikey:key},signal:AbortSignal.timeout(10000)});
console.log(JSON.stringify({check:'public-auth-settings',status:response.status}));
console.log('No account sign-in, party membership, private channel authorization or media playback tested by this probe.');
