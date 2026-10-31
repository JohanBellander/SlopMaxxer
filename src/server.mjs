// Tiny local web server: polls in the background and serves the dashboard on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { loadConfig } from './discover.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer({ port = 4747, onReady } = {}) {
  const config = loadConfig();
  const pollMs = Math.max(60_000, (config.pollSeconds || 120) * 1000);
  let snapshot = null;
  let inflight = null;

  const refresh = () => {
    inflight ??= collect()
      .then((s) => (snapshot = s))
      .catch((e) => console.error('[slopmaxxer] poll failed:', e.message))
      .finally(() => (inflight = null));
    return inflight;
  };
  refresh();
  setInterval(refresh, pollMs).unref?.();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/snapshot') {
      if (url.searchParams.has('refresh') || !snapshot) await refresh();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ...snapshot, pollMs }));
    }
    const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    fs.createReadStream(full).pipe(res);
  });

  server.listen(port, '127.0.0.1', () => onReady?.(`http://127.0.0.1:${port}`));
  return server;
}
