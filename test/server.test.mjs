import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startServer } from '../src/server.mjs';
import { derive } from '../public/guidance.js';

test('occupied default port falls back and reports the actual working URL', async (t) => {
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  let server;
  const url = await new Promise((resolve, reject) => {
    server = startServer({ port, demo: true, fallbackPort: true, onReady: resolve, onError: reject });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.notEqual(new URL(url).port, String(port));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(server.address().address, '127.0.0.1');
  const response = await fetch(`${url}/api/slop`);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).accounts.length > 0);
});

test('an explicitly requested occupied port reports an error without fallback', async (t) => {
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const error = await new Promise((resolve, reject) => {
    startServer({ port: occupied.address().port, demo: true, onError: resolve,
      onReady: () => reject(new Error('Should not start on another port')) });
  });
  assert.equal(error.code, 'EADDRINUSE');
});

test('/api/slop carries the dashboard verdict for clients that cannot run guidance.js (the tray)', async (t) => {
  let server;
  const url = await new Promise((resolve, reject) => {
    server = startServer({ port: 0, demo: true, onReady: resolve, onError: reject });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`${url}/api/slop`);
  // The tray is Windows PowerShell: without a charset it decodes UTF-8 arrows as mojibake.
  assert.match(response.headers.get('content-type'), /charset=utf-8/);
  const body = await response.json();
  // Same verdict the dashboard derives from the same snapshot: no second decision engine.
  // (The why text can differ by an hour-boundary rounding: the server derives a
  // millisecond after the snapshot, whose mock reset sits exactly on the hour.)
  const vm = derive({ ...body, now: body.now });
  assert.equal(body.guidance.verdict.word, vm.verdict.word);
  assert.equal(body.guidance.verdict.arrow, vm.verdict.arrow);
  assert.equal(body.guidance.verdict.tone, vm.verdict.tone);
  assert.match(body.guidance.verdict.why, /of Weekly allowance remains/);
  assert.equal(body.guidance.verdict.word, 'Speed up.');
  assert.deepEqual(body.guidance.next, {
    id: vm.next.id, provider: vm.next.provider, slug: vm.next.slug, label: vm.next.label, status: vm.next.status,
  });
});
