// Tiny local web server on 127.0.0.1 only. It polls the providers on demand: only when a dashboard
// (or other client) asks and the last reading is older than pollMs, so nobody watching = no requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, warmHistory } from './collect.mjs';
import { loadConfig } from './discover.mjs';
import { demoSnapshot } from './demo.mjs';
import { shiftedMock } from './mock.mjs';
import { buildSlopSnapshot } from './snapshot.mjs';
import { derive } from '../public/guidance.js';
import { log, since } from './log.mjs';

const CLIENT_LOG_MAX = 8 * 1024;

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

export function startServer({ port = 4747, demo = false, fallbackPort = false, warm = true, onReady, onError } = {}) {
  const config = loadConfig();
  const pollMs = Math.max(60_000, (config.pollSeconds || 120) * 1000);
  let snapshot = null; // classic shape: /api/snapshot (classic.html, CLI)
  let slop = null; // design shape (design/types.ts): /api/slop (index.html)
  let inflight = null;
  let fetchedAt = 0; // when the last provider poll started
  let lastVerdict = null; // only log guidance when it changes

  const refresh = (reason) => {
    if (demo) {
      snapshot = demoSnapshot();
      slop = shiftedMock();
      return Promise.resolve(snapshot);
    }
    if (inflight) {
      log.debug('poll.joined', { reason });
      return inflight;
    }
    const prevAt = fetchedAt;
    const t0 = (fetchedAt = Date.now());
    log.info('poll.start', { reason, sinceLastSec: prevAt ? Math.round((t0 - prevAt) / 1000) : null });
    inflight = collect()
      .then((s) => {
        snapshot = s;
        try {
          slop = buildSlopSnapshot(s, { ms: Date.now() - t0 });
          log.info('poll.done', { ms: Date.now() - t0, accounts: slop.accounts.length, events: slop.events.length - 1 });
        } catch (e) {
          console.error('[slopmaxxer] snapshot build failed:', e.message);
          log.error('snapshot.build_failed', { error: e });
        }
      })
      .catch((e) => {
        console.error('[slopmaxxer] poll failed:', e.message);
        log.error('poll.failed', { ms: Date.now() - t0, error: e });
      })
      .finally(() => (inflight = null));
    return inflight;
  };
  // No background timer: re-poll only when someone asks and the reading has aged past pollMs.
  const ensureFresh = (force) => {
    const reason = force ? 'forced' : !snapshot ? 'first' : Date.now() - fetchedAt >= pollMs ? 'aged' : null;
    return reason ? refresh(reason) : undefined;
  };

  // The tray popup cannot run guidance.js, so /api/slop carries the dashboard's verdict
  // ready-made. Decisions stay in guidance.js; this only copies its output, derived
  // against the real clock exactly like index.html does before rendering.
  const withGuidance = (body) => {
    if (!body?.accounts) return body;
    try {
      const vm = derive({ ...body, now: new Date().toISOString() });
      const next = vm.next
        ? { id: vm.next.id, provider: vm.next.provider, slug: vm.next.slug, label: vm.next.label, status: vm.next.status }
        : null;
      const key = `${vm.verdict?.word}|${next?.id || '-'}|${next?.status || '-'}`;
      if (key !== lastVerdict) {
        lastVerdict = key;
        log.info('guidance.changed', {
          verdict: vm.verdict?.word, why: vm.verdict?.why, next: next && `${next.provider}:${next.id}`, nextStatus: next?.status,
          accounts: vm.accounts?.map((a) => `${a.provider}:${a.id} ${a.status}${a.usable ? '' : ' unusable'}`),
        });
      }
      return { ...body, guidance: { verdict: vm.verdict, next } };
    } catch (e) {
      log.error('guidance.failed', { error: e });
      return body; // a guidance failure must not take the snapshot down with it
    }
  };

  // The dashboard reports its own errors here so they land in the same local log.
  const clientLog = (req, res) => {
    // JSON only: a cross-site page can't send this content type without a preflight we never answer.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      res.writeHead(415);
      return res.end();
    }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > CLIENT_LOG_MAX) tooBig = true;
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413);
        return res.end();
      }
      let entry;
      try { entry = JSON.parse(body); } catch { entry = null; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        res.writeHead(400);
        return res.end();
      }
      const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
      const ev = typeof entry.ev === 'string' ? entry.ev.slice(0, 60).replace(/[^\w.-]/g, '_') : 'event';
      const { level: _l, ev: _e, ...fields } = entry;
      log[level](`client.${ev}`, fields);
      res.writeHead(204);
      res.end();
    });
  };

  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...body, pollMs }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const force = url.searchParams.has('refresh');
    const t0 = performance.now();
    res.on('finish', () => {
      const api = url.pathname.startsWith('/api/');
      log[res.statusCode >= 400 ? 'warn' : api ? 'info' : 'debug']('http', {
        method: req.method, path: url.pathname, force: force || undefined, status: res.statusCode, ms: since(t0),
        client: api ? (req.headers['user-agent'] || '').slice(0, 60) : undefined,
      });
    });
    if (url.pathname === '/api/log' && req.method === 'POST') return clientLog(req, res);
    if (url.pathname === '/api/snapshot') {
      await ensureFresh(force);
      return json(res, snapshot);
    }
    if (url.pathname === '/api/slop') {
      await ensureFresh(force || !slop);
      return json(res, withGuidance(slop));
    }
    // Old bookmarks use the same decision UI; the archived page has obsolete verdict rules.
    const file = ['/', '/classic', '/classic.html'].includes(url.pathname) ? 'index.html' : path.basename(url.pathname);
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type.startsWith('text/') || type.endsWith('svg+xml') ? `${type}; charset=utf-8` : type });
    fs.createReadStream(full).pipe(res);
  });

  let retried = false;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && fallbackPort && !retried) {
      retried = true;
      log.warn('server.port_in_use', { port, fallback: 'random free port' });
      server.listen(0, '127.0.0.1');
      return;
    }
    log.error('server.error', { port, error });
    if (onError) onError(error);
    else throw error;
  });
  server.once('listening', () => {
    log.info('server.listening', { port: server.address().port, demo, pollMs });
    onReady?.(`http://127.0.0.1:${server.address().port}`);
    // Disk-only warm-up so the first click doesn't wait several seconds for transcript parsing.
    if (!demo && warm) setTimeout(() => { try { warmHistory(); } catch (e) { log.warn('backfill.warm_failed', { error: e }); } }, 0);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
