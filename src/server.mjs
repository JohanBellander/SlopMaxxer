// Tiny local web server on 127.0.0.1 only. It polls the providers on demand: only when a dashboard
// (or other client) asks and the last reading is older than pollMs, so nobody watching = no requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';
import { loadConfig } from './discover.mjs';
import { demoSnapshot } from './demo.mjs';
import { shiftedMock } from './mock.mjs';
import { buildSlopSnapshot } from './snapshot.mjs';
import { derive } from '../public/guidance.js';
import { log, since } from './log.mjs';

const CLIENT_LOG_MAX = 8 * 1024;
const FORCE_MIN_MS = 30_000; // a forced refresh never polls the providers more often than this
// DNS rebinding: a page on evil.example can resolve to 127.0.0.1, but its requests still say Host: evil.example.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const localHost = (host) => LOCAL_HOSTS.has(String(host || '').replace(/:\d*$/, '').toLowerCase().replace(/\.$/, ''));

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

// `collector` is a test seam; production always uses collect().
export function startServer({ port = 4747, demo = false, fallbackPort = false, onReady, onError, collector = collect } = {}) {
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
    inflight = collector()
      .then((s) => {
        snapshot = s;
        try {
          slop = buildSlopSnapshot(s, { ms: Date.now() - t0 });
          log.info('poll.done', { ms: Date.now() - t0, accounts: slop.accounts.length });
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
  // A forced refresh (the dashboard's sync button) still waits FORCE_MIN_MS after the last poll started.
  const ensureFresh = (force) => {
    const forced = force && Date.now() - fetchedAt >= FORCE_MIN_MS;
    // A failed first poll leaves no snapshot; retrying it waits the same floor, or every GET would poll.
    const first = !snapshot && (!fetchedAt || Date.now() - fetchedAt >= FORCE_MIN_MS);
    const reason = forced ? 'forced' : first ? 'first' : snapshot && Date.now() - fetchedAt >= pollMs ? 'aged' : null;
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
    const text = JSON.stringify({ ...body, pollMs }); // before the headers, so a failure can still answer 500
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    let url = null;
    try { url = new URL(req.url, 'http://localhost'); } catch { /* e.g. "//": answered 400 below */ }
    // Only our own clients send this header; a cross-site page can't without a preflight we never answer.
    const force = !!url?.searchParams.has('refresh') && req.headers['x-slopmaxxer-refresh'] === '1';
    const t0 = performance.now();
    res.on('finish', () => {
      const api = !!url?.pathname.startsWith('/api/');
      log[res.statusCode >= 400 ? 'warn' : api ? 'info' : 'debug']('http', {
        method: req.method, path: url?.pathname ?? String(req.url).slice(0, 120), force: force || undefined,
        status: res.statusCode, ms: since(t0), client: api ? (req.headers['user-agent'] || '').slice(0, 60) : undefined,
      });
    });
    if (!url) {
      res.writeHead(400);
      return res.end();
    }
    if (!localHost(req.headers.host)) {
      res.writeHead(421);
      return res.end();
    }
    try {
      await route(url, force, req, res);
    } catch (error) {
      log.error('http.failed', { path: url.pathname, error });
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      } else res.destroy();
    }
  });

  const route = async (url, force, req, res) => {
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
    // Regular files only, so a directory can never reach createReadStream.
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type.startsWith('text/') || type.endsWith('svg+xml') ? `${type}; charset=utf-8` : type });
    fs.createReadStream(full)
      .on('error', (error) => {
        // File gone mid-serve, a directory, or the client hung up: headers are out, so just close.
        log.warn('http.static_failed', { path: url.pathname, error });
        res.destroy();
      })
      .pipe(res);
  };

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
  });
  server.listen(port, '127.0.0.1');
  return server;
}
