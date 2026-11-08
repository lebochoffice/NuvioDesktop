// Local browser exercise with synthetic RPC/WebSocket fixtures, no real credentials.
// Optional: npm install --no-save playwright, or set NUVIO_PLAYWRIGHT_PACKAGE.
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {strict as assert} from 'node:assert';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.NUVIO_PLAYWRIGHT_PACKAGE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4173;
const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, env: {...process.env, VITE_SUPABASE_URL:'https://backend.invalid', VITE_SUPABASE_ANON_KEY:'sb_publishable_SYNTHETIC_TEST_ONLY'}, stdio: 'pipe',
});
let serverOutput = '';
child.stdout.on('data', d => {serverOutput += d;}); child.stderr.on('data', d => {serverOutput += d;});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) {ready = true; break;} } catch {}
    await delay(200);
  }
  assert.ok(ready, 'Vite did not start: ' + serverOutput);
  browser = await chromium.launch({headless: true, ...(process.env.NUVIO_BROWSER_PATH ? {executablePath: process.env.NUVIO_BROWSER_PATH} : {})});
  const page = await browser.newPage();
  const errors = [], requests = [], broadcasts = [];
  page.on('pageerror', e => errors.push(e.message));
  let socket, topic;
  const media = {meta_type:'movie', meta_id:'tt1', title:'Synthetischer Integrationstest'};
  const playback = {seq:1, member_id:'host', paused:true, position_ms:0, rate:1, at:Date.now(), media_key:'movie|tt1||'};
  const snapshot = {party:{id:'room-1',code:'UXZ83H',host_member_id:'host',host_only:true,media,playback,max_members:3},member_id:'guest',members:[{id:'host',display_name:'Host'},{id:'guest',display_name:'Browser-Gast'}]};
  const token = ['e30', Buffer.from(JSON.stringify({sub:'test-user', role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'), 'test-signature'].join('.');
  await page.route('https://backend.invalid/**', async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').at(-1);
    requests.push({name,body:request.postDataJSON()});
    let response;
    if (name === 'token') response = {access_token:token,token_type:'bearer',expires_in:3600,refresh_token:'test-refresh',user:{id:'test-user',email:'test@example.invalid',is_anonymous:false}};
    else if (name === 'watch_party_clock') response = Date.now();
    else if (name === 'watch_party_list_messages') response = {messages:[{id:1,member_id:'host',name:'Host',body:'<img src=x onerror=alert(1)>'}]};
    else if (name === 'watch_party_preview') response = {media,host:snapshot.members[0],members:2,max_members:3};
    else if (name === 'watch_party_send_message') response = {message:{id:2,body:'Hallo'}};
    else response = snapshot;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
  });
  await page.routeWebSocket('wss://backend.invalid/**', ws => {
    assert.equal(new URL(ws.url()).searchParams.get('nuvio_realtime'), '1', 'Nuvio gateway routing marker must match Desktop');
    socket = ws;
    ws.onMessage(raw => {
      const m = JSON.parse(String(raw));
      if (m.event === 'phx_join') topic = m.topic;
      if (m.event === 'broadcast') broadcasts.push(m.payload);
      ws.send(JSON.stringify({topic:m.topic,event:'phx_reply',ref:m.ref,join_ref:m.join_ref,payload:{status:'ok',response:{postgres_changes:[]}}}));
    });
  });
  await page.goto(`http://127.0.0.1:${port}/party/UXZ83H`);
  // Invite first: name + "Jetzt ansehen"; the account step opens only without a session.
  assert.equal(await page.locator('#partyCode').inputValue(),'UXZ83H');
  assert.equal(await page.locator('#partyCode').isVisible(), false); // Code comes from the link.
  assert.equal(await page.locator('#displayName').count(), 0); // No name field any more.
  await page.locator('#email').fill('test@example.invalid'); await page.locator('#password').fill('synthetic-password');
  await page.locator('#joinButton').click(); // Sign-in and join in one flow.
  await page.locator('#watchSection').waitFor({state:'visible'});
  await page.waitForFunction(() => document.getElementById('connection').textContent === 'Verbunden');
  assert.ok(requests.some(r => r.name === 'watch_party_join' && r.body.p_code === 'UXZ83H'));
  await page.locator('#ctlSettings').click();
  await page.locator('#tabChat').click();
  await page.getByText('<img src=x onerror=alert(1)>', {exact:false}).waitFor();
  assert.equal(await page.locator('#chatLog img').count(), 0);
  await page.locator('#chatText').fill('Hallo'); await page.locator('#chatForm button').click();
  await page.waitForFunction(() => document.getElementById('chatText').value === '');
  await page.locator('#drawerClose').click();
  const emit = (event, payload) => socket.send(JSON.stringify({topic,event:'broadcast',payload:{event,payload}}));
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'https://cdn.invalid/film.mkv'}});
  await page.getByText(/MKV, AVI/).waitFor();
  assert.equal(await page.locator('#loadStream').isVisible(), false);
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'https://cdn.invalid/video.mp4',headers:{Authorization:'SYNTHETIC'}}});
  await page.getByText(/eigene HTTP-Header/).waitFor();
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'http://cdn.invalid/video.mp4'}});
  await page.getByText(/öffentliche HTTPS-Adresse/).waitFor();
  // A media source is never fetched before the explicit load action.
  let mediaRequests = 0;
  await page.route('https://cdn.invalid/**', async route => {mediaRequests++; await route.abort('failed');});
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'https://cdn.invalid/video.mp4'}});
  await page.locator('#loadStream').waitFor({state:'visible'});
  assert.equal(mediaRequests,0);
  await page.locator('#loadStream').click();
  await page.getByText(/Video nicht abspielbar/).waitFor();
  assert.ok(mediaRequests > 0); assert.equal(await page.locator('#resync').isDisabled(),true);
  // Personal HLS regression: real hls.js must request the relative segment.
  // The segment deliberately returns 410; this is NOT a playback success test.
  const personalSentinel = 'PERSONAL_HLS_TEST_ONLY';
  const relativeSegments = [];
  await page.route('https://hls.invalid/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/owned/master') return route.fulfill({status:200,contentType:'application/vnd.apple.mpegurl',headers:{'Access-Control-Allow-Origin':'*'},body:'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nsegments/000.ts\n#EXT-X-ENDLIST\n'});
    relativeSegments.push(route.request().url());
    return route.fulfill({status:410,headers:{'Access-Control-Allow-Origin':'*'},body:'Fixture segment expired'});
  });
  await page.locator('#membersButton').click(); // Participants badge opens the drawer.
  await page.locator('summary').filter({hasText:'Technik'}).click();
  await page.getByText('Eigene HLS-URL (Beta)',{exact:true}).click();
  await page.locator('#personalHlsUrl').fill(`https://hls.invalid/owned/master?token=${personalSentinel}`);
  await page.locator('#loadPersonalHls').click();
  await page.getByText(/HLS-Playlist oder Segment nicht mehr verfügbar/).first().waitFor();
  assert.ok(relativeSegments.includes('https://hls.invalid/owned/segments/000.ts'));
  assert.equal(await page.locator('#personalHlsUrl').inputValue(),'');
  assert.equal(await page.locator('#resync').isDisabled(),true);
  snapshot.party.media.title = 'Private HLS retained';
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'https://cdn.invalid/ignored.mkv'}});
  // The following frame triggers a heartbeat/title update; observing it proves
  // the earlier stream frame has been handled (no timing-only sleep/assertion).
  emit('control', {host_only:true});
  await page.getByRole('heading',{name:'Private HLS retained',exact:true}).waitFor();
  assert.match(await page.locator('#message').textContent(), /HLS-Playlist oder Segment nicht mehr verfügbar/);
  assert.ok(requests.every(r => !String(JSON.stringify(r.body)).includes(personalSentinel)));
  assert.ok(broadcasts.every(b => !JSON.stringify(b).includes(personalSentinel)));
  assert.equal(await page.evaluate(sentinel => Object.values(localStorage).some(value => value.includes(sentinel)), personalSentinel),false);
  await page.locator('#useDesktopStream').click();
  await page.locator('#drawerClose').click();
  snapshot.party.media.title = 'Synthetischer Integrationstest';
  // Generate our own short VP8/WebM fixture inside Chrome. No external media.
  const videoBytes = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(12), chunks = [];
    const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
    const result = new Promise(resolve => {
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(chunks, {type:'video/webm'}).arrayBuffer());
        let binary = ''; bytes.forEach(b => {binary += String.fromCharCode(b);}); resolve(btoa(binary));
      };
    });
    let frame = 0;
    const timer = setInterval(() => {ctx.fillStyle = frame++ % 2 ? '#ee9966' : '#6688ee';ctx.fillRect(0,0,320,180);},80);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 4000));
    recorder.stop(); clearInterval(timer); stream.getTracks().forEach(t => t.stop());
    return result;
  }), 'base64');
  await page.unroute('https://cdn.invalid/**');
  await page.route('https://cdn.invalid/**', route => route.fulfill({status:200,contentType:'video/webm',headers:{'Access-Control-Allow-Origin':'*'},body:videoBytes}));
  emit('stream', {member_id:'host',stream:{media_key:'movie|tt1||',url:'https://cdn.invalid/fixture.webm'}});
  await page.locator('#loadStream').waitFor({state:'visible'}); await page.locator('#loadStream').click();
  await page.waitForFunction(() => !document.getElementById('resync').disabled);
  emit('state', {...playback,seq:2,paused:false,position_ms:1000,at:Date.now()});
  await page.locator('#resync').click();
  await page.waitForFunction(() => {const p=document.getElementById('player');return !p.paused && p.currentTime >= .9;});
  emit('state', {...playback,seq:3,paused:true,position_ms:300,at:Date.now()});
  await page.waitForFunction(() => {const p=document.getElementById('player');return p.paused && Math.abs(p.currentTime-.3)<.51;});
  emit('stream', {member_id:'host',stream:null});
  await page.waitForFunction(() => !document.getElementById('player').getAttribute('src'));
  assert.equal(await page.locator('#resync').isDisabled(),true);
  assert.ok(broadcasts.some(b => b.event === 'state_request'));
  assert.ok(broadcasts.some(b => b.event === 'status' && b.payload.status === 'browsing'));
  assert.ok(!broadcasts.some(b => b.event === 'state'));
  await page.screenshot({path: new URL('../browser-smoke.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'), fullPage:true});
  await page.locator('#membersButton').click(); // Participants badge opens the drawer.
  await page.locator('#leaveButton').click(); await page.locator('#joinSection').waitFor({state:'visible'});
  assert.ok(requests.some(r => r.name === 'watch_party_leave'));
  assert.deepEqual(errors, []);
  console.log('PASS: synthetic Chrome checks, personal HLS relative-segment request/privacy/error protection, and generated WebM host sync. No real TorBox HLS playback is confirmed by this fixture.');
} finally { await browser?.close(); child.kill(); }
