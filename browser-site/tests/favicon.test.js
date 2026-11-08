import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {existsSync, readFileSync} from 'node:fs';

test('the browser links the original Nuvio favicon and correctly sized PNG icons', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const asset = name => readFileSync(new URL('../public/' + name, import.meta.url));
  assert.match(html, /<link rel="icon" href="\/favicon\.ico">/);
  const ico = asset('favicon.ico');
  assert.equal(ico.subarray(0, 4).toString('hex'), '00000100');
  const original = new URL('../../composeApp/src/desktopMain/resources/icons/app-icon-original-transparent.ico', import.meta.url);
  if (existsSync(original)) assert.deepEqual(ico, readFileSync(original));
  for (const [name, size, rel] of [['favicon-32x32.png', 32, 'icon'], ['apple-touch-icon.png', 180, 'apple-touch-icon']]) {
    const link = html.match(/<link [^>]+>/g).find(tag => tag.includes('href="/' + name + '"'));
    assert.ok(link, name + ' is linked');
    assert.ok(link.includes('rel="' + rel + '"'));
    assert.ok(link.includes('sizes="' + size + 'x' + size + '"'));
    const png = asset(name);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
