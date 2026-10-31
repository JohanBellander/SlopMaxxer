import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startServer } from '../src/server.mjs';

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
