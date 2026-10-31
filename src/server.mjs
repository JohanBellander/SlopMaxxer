// Tiny local web server: polls in the background and serves the dashboard on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { loadConfig } from './discover.mjs';
import { demoSnapshot } from './demo.mjs';
import { shiftedMock } from './mock.mjs';
import { buildSlopSnapshot } from './snapshot.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function startServer({ port = 4747, demo = false, fallbackPort = false, onReady, onError } = {}) {
  const config = loadConfig();
  const pollMs = Math.max(60_000, (config.pollSeconds || 120) * 1000);
  let snapshot = null; // classic shape: /api/snapshot (classic.html, CLI)
  let slop = null; // design shape (design/types.ts): /api/slop (index.html)
  let inflight = null;

  const refresh = () => {
    if (demo) {
      snapshot = demoSnapshot();
      slop = shiftedMock();
      return Promise.resolve(snapshot);
    }
    const t0 = Date.now();
    inflight ??= collect()
      .then((s) => {
        snapshot = s;
        try {
          slop = buildSlopSnapshot(s, { ms: Date.now() - t0 });
        } catch (e) {
          console.error('[slopmaxxer] snapshot build failed:', e.message);
        }
      })
      .catch((e) => console.error('[slopmaxxer] poll failed:', e.message))
      .finally(() => (inflight = null));
    return inflight;
  };
  refresh();
  const timer = setInterval(refresh, pollMs);
  timer.unref?.();

  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...body, pollMs }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const force = url.searchParams.has('refresh');
    if (url.pathname === '/api/snapshot') {
      if (force || !snapshot) await refresh();
      return json(res, snapshot);
    }
    if (url.pathname === '/api/slop') {
      if (force || !slop) await refresh();
      return json(res, slop);
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname === '/classic' ? 'classic.html' : path.basename(url.pathname);
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': `${TYPES[path.extname(full)] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(full).pipe(res);
  });

  let retried = false;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && fallbackPort && !retried) {
      retried = true;
      server.listen(0, '127.0.0.1');
      return;
    }
    clearInterval(timer);
    if (onError) onError(error);
    else throw error;
  });
  server.once('close', () => clearInterval(timer));
  server.once('listening', () => onReady?.(`http://127.0.0.1:${server.address().port}`));
  server.listen(port, '127.0.0.1');
  return server;
}
