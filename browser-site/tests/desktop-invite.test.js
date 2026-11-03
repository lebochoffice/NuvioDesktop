import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the actual patched overlay code, not a duplicate of its link logic.
const desktopCandidates = ['../../composeApp/src/desktopMain/resources/player-ui/party.js', '../../../NuvioDesktop/composeApp/src/desktopMain/resources/player-ui/party.js'].map(p => new URL(p, import.meta.url));
const desktopPath = desktopCandidates.find(p => existsSync(p));
const source = desktopPath ? readFileSync(desktopPath, 'utf8') : '';
const start = source.indexOf('// NUVIO_BROWSER_PARTY_BRIDGE_V1:');
if (source) assert.ok(start >= 0, 'Desktop bridge must be applied before this integration test');
const bridge = source.slice(start, source.indexOf('const buildPartyHostSettings', start));
function setup(party, initialStorage = {}) {
  const events = [], confirmations = [];
  const stored = new Map(Object.entries(initialStorage));
  const element = (tag, className) => ({tag, className, attrs: new Map(), children: [], style: {}, appendChild(child) {this.children.push(child);}, setAttribute(k, v) {this.attrs.set(k, v);}, getAttribute(k) {return this.attrs.get(k);}, addEventListener() {}});
  const context = {URL, TextEncoder, btoa, partySwitchSettleMs: 0, window:{setTimeout() {}, localStorage:{getItem:k => stored.get(k), setItem:(k,v) => stored.set(k,v)}}, partyElement: element,
    partyAction: (el, _key, click) => Object.assign(el, {click}),
    partyEncodeText: text => Buffer.from(text).toString('base64url'),
    partyButtonElement: (_label, _style, _action, click) => ({click}),
    send: (type, value) => events.push({type, value}), showPartyConfirm: config => confirmations.push(config)};
  vm.createContext(context);
  const switches = source.slice(source.indexOf('const buildPartySwitch ='), start);
  vm.runInContext(switches + bridge + '\nglobalThis.buildBridge = buildPartyBrowserShare; globalThis.buildSwitch = buildPartySwitch;', context);
  const section = context.buildBridge(party);
  const input = section.children.find(child => child.tag === 'input' && child.className === 'party-browser-host');
  assert.ok(input, 'The harness must edit the actual browser address input');
  const button = section.children.at(-1), nuvioButton = section.children.at(-2);
  return {input, button, nuvioButton, events, confirmations, sharingSwitch: () => context.buildSwitch('sharing', 'Share', '', party.sharing, 'partySharing')};
}
test('host browser invite copies exactly the current code without granting stream consent', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code:'UXZ83H', sharing:false});
  f.input.value = 'https://MEINE-SEITE.pages.dev/'; f.button.click();
  assert.equal(f.events.length, 1); assert.equal(f.confirmations.length, 0);
  assert.equal(f.events[0].value, 0);
  assert.ok(f.events[0].type.startsWith('partyBrowserInvite:'));
  assert.equal(Buffer.from(f.events[0].type.split(':')[1], 'base64url').toString(), 'https://meine-seite.pages.dev/party/UXZ83H');
});

test('the existing sharing switch requires confirmation, while copying the default invite does not grant it', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code: 'UXZ83H', sharing: false});
  assert.equal(f.input.value, 'https://nuvio-watch-friends.pages.dev');
  f.button.click(); assert.equal(f.events[0].value, 0);
  const toggle = f.sharingSwitch(); toggle.click();
  assert.equal(f.events.length, 1); assert.equal(f.confirmations.length, 1);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  f.confirmations[0].onConfirm();
  assert.equal(f.events[1].type, 'partySharing'); assert.equal(f.events[1].value, 1);
  toggle.click(); // Revoking sharing requires no additional grant.
  assert.equal(f.events[2].type, 'partySharing'); assert.equal(f.events[2].value, 0);
  assert.equal(f.confirmations.length, 1);
});

test('invalid codes cannot copy an invite and the native handler has no invite-to-sharing side effect', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  for (const code of ['UXZ83H/other', 'ABC', 'UXZ83I']) {
    const f = setup({code, sharing: false}); f.button.click();
    assert.equal(f.events.length, 0); assert.equal(f.confirmations.length, 0);
  }
  const controls = readFileSync(new URL('../../../commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimePartyControls.kt', desktopPath), 'utf8');
  const inviteBranch = controls.slice(controls.indexOf('if (type.startsWith(BROWSER_INVITE_EVENT))'), controls.indexOf('if (type.startsWith(REMOVE_MEMBER_EVENT))'));
  assert.ok(inviteBranch.includes('copyBrowserInvite(url)'));
  assert.ok(!inviteBranch.includes('setSharing('));
});
test('existing sharing copies without toggling it, invalid addresses never prompt or enable sharing', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code:'UXZ83H', sharing:true});
  f.input.value = 'https://my-site.pages.dev'; f.button.click();
  assert.equal(f.events[0].value, 0); assert.equal(f.confirmations.length, 0);
  for (const address of ['http://my-site.pages.dev', 'https://user:secret@site.example', 'https://@site.example', 'https://site.example/path', 'https://site.example/?key=secret', 'https://site.example/#token', 'https://site.example/?', 'https://site.example/#', 'https://site.example/a/../', 'https://site.example/\\evil', 'https://site.example/\n']) {
    const bad = setup({code:'UXZ83H', sharing:false}); bad.input.value = address; bad.button.click();
    assert.equal(bad.events.length, 0, address); assert.equal(bad.confirmations.length, 0, address);
  }
});

test('0.1.37: old stored hosts and Cloudflare preview URLs never become invitation targets', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const old = setup({code: 'UXZ83H', sharing: false}, {'nuvio-browser-party-host': 'https://abc123.old-preview.pages.dev'});
  assert.equal(old.input.value, 'https://nuvio-watch-friends.pages.dev'); // v1 key ignored.
  const preview = setup({code: 'UXZ83H', sharing: false}, {'nuvio-browser-party-host-v2': 'https://f00d.nuvio-watch-friends.pages.dev'});
  assert.equal(preview.input.value, 'https://nuvio-watch-friends.pages.dev');
  preview.button.click();
  assert.equal(Buffer.from(preview.events[0].type.split(':')[1], 'base64url').toString(), 'https://nuvio-watch-friends.pages.dev/party/UXZ83H');
  const typed = setup({code: 'UXZ83H', sharing: false});
  typed.input.value = 'https://f00d.nuvio-watch-friends.pages.dev'; typed.button.click();
  assert.equal(typed.events.length, 0); // Preview hosts are rejected.
});


// Preview origin only when the build chose it (PartyBrowserConfig). Written, not executed here.
const decode = f => Buffer.from(f.events.at(-1).type.split(':')[1], 'base64url').toString();
test('production build: "Watch in Browser" defaults to production and rejects the feature preview host', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code: 'UXZ83H', sharing: false, browserOrigin: 'https://nuvio-watch-friends.pages.dev'});
  assert.equal(f.input.value, 'https://nuvio-watch-friends.pages.dev');
  f.button.click(); assert.equal(decode(f), 'https://nuvio-watch-friends.pages.dev/party/UXZ83H');
  f.input.value = 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev'; f.button.click();
  assert.equal(f.events.length, 1); // Preview host refused in a production build.
});
test('preview test build: the invite uses exactly the configured preview, even over a stored production host', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code: 'UXZ83H', sharing: false, browserOrigin: 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev'},
    {'nuvio-browser-party-host-v2': 'https://nuvio-watch-friends.pages.dev'});
  assert.equal(f.input.value, 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev');
  f.button.click(); assert.equal(decode(f), 'https://feature-party-premium-ui.nuvio-watch-friends.pages.dev/party/UXZ83H');
  f.input.value = 'https://abc123.nuvio-watch-friends.pages.dev'; f.button.click();
  assert.equal(f.events.length, 1); // Other preview hosts stay refused.
});
test('an unexpected origin from the app falls back to production', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code: 'UXZ83H', sharing: false, browserOrigin: 'https://evil.example'});
  assert.equal(f.input.value, 'https://nuvio-watch-friends.pages.dev');
});

test('"Watch in Nuvio" copies the original Nuvio invite; "Watch in Browser" stays the last button', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code:'UXZ83H', sharing:false});
  f.nuvioButton.click();
  assert.deepEqual(f.events, [{type: 'partyCopyNuvioLink', value: 0}]); // Kotlin copies https://nuvio.tv/party/<CODE>.
  f.button.click();
  assert.equal(f.events[1].type.split(':')[0], 'partyBrowserInvite');
  assert.equal(f.confirmations.length, 0);
});
