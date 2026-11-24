import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url));

test('Windows installer is ASCII without BOM and has literal CRLF on every line', () => {
  const bytes = read('install-windows.cmd');
  assert.ok(bytes.every(b => b < 128), 'CMD must not depend on a Unicode code page');
  const text = bytes.toString('ascii');
  assert.ok(text.startsWith('@echo off\r\n'));
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[\r\n]/.test(text.replaceAll('\r\n', '')), 'No bare LF or CR');
});

test('Git preserves installer bytes in checkouts and source archives', () => {
  const attributes = read('../../.gitattributes').toString();
  assert.match(attributes, /^integrations\/vk\/\*\.cmd -text diff whitespace=cr-at-eol$/m);
});

test('installer retains safety checks, confirmation, pinned CLI and existing variables', () => {
  const text = read('install-windows.cmd').toString('ascii');
  const lines = text.split('\r\n');
  const labels = new Set(lines.filter(l => l.startsWith(':')).map(l => l.slice(1)));
  for (const match of text.matchAll(/\bgoto (\w+)/g)) assert.ok(labels.has(match[1]), match[1]);
  assert.match(text, /choice \/c YN/);
  assert.match(text, /if errorlevel 2 goto cancelled/);
  assert.match(text, /where node/);
  assert.match(text, /if not exist "worker\.mjs"/);
  assert.match(text, /call npx\.cmd --yes wrangler@4\.168\.0 login/);
  assert.match(text, /call npx\.cmd --yes wrangler@4\.168\.0 deploy --keep-vars/);
  assert.ok(!text.includes('secret put'), 'Never ask for the VK token in this installer');
  for (const label of ['missing_node', 'missing_files', 'failed', 'cancelled']) {
    const section = text.split(':' + label + '\r\n')[1].split(/\r\n:\w+/)[0];
    assert.match(section, /\r\npause\r\nexit \/b [01]/);
  }
});
