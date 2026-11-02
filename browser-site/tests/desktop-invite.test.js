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
function setup(party) {
  const events = [], confirmations = [];
  const stored = new Map();
  const element = () => ({children: [], style: {}, appendChild(child) {this.children.push(child);}, setAttribute() {}, addEventListener() {}});
  const context = {URL, TextEncoder, btoa, window:{localStorage:{getItem:k => stored.get(k), setItem:(k,v) => stored.set(k,v)}}, partyElement: element,
    partyEncodeText: text => Buffer.from(text).toString('base64url'),
    partyButtonElement: (_label, _style, _action, click) => ({click}),
    send: (type, value) => events.push({type, value}), showPartyConfirm: config => confirmations.push(config)};
  vm.createContext(context);
  vm.runInContext(bridge + '\nglobalThis.buildBridge = buildPartyBrowserShare;', context);
  const section = context.buildBridge(party);
  const input = section.children[2], button = section.children.at(-1);
  return {input, button, events, confirmations};
}
test('host browser invite requires explicit consent and encodes exactly the current code', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code:'UXZ83H', sharing:false});
  f.input.value = 'https://MEINE-SEITE.pages.dev/'; f.button.click();
  assert.equal(f.events.length, 0); assert.equal(f.confirmations.length, 1);
  f.confirmations[0].onConfirm();
  assert.equal(f.events.length, 1); assert.equal(f.events[0].value, 1);
  assert.equal(Buffer.from(f.events[0].type.split(':')[1], 'base64url').toString(), 'https://meine-seite.pages.dev/party/UXZ83H');
});
test('existing sharing copies without toggling it, invalid addresses never prompt or enable sharing', {skip: !source && 'Separate browser repository: desktop source unavailable'}, () => {
  const f = setup({code:'UXZ83H', sharing:true});
  f.input.value = 'https://my-site.pages.dev'; f.button.click();
  assert.equal(f.events[0].value, 0); assert.equal(f.confirmations.length, 0);
  for (const address of ['http://my-site.pages.dev', 'https://user:secret@site.example', 'https://site.example/path', 'https://site.example/?key=secret']) {
    const bad = setup({code:'UXZ83H', sharing:false}); bad.input.value = address; bad.button.click();
    assert.equal(bad.events.length, 0, address); assert.equal(bad.confirmations.length, 0, address);
  }
});
