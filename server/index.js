/**
 * The Circle — local control server.
 *
 * Serves the overlay (for an OBS Browser Source) and the control panel (for an OBS Custom
 * Browser Dock) from one origin, and pushes state changes over SSE. SSE rather than a
 * WebSocket library because the traffic is one-way — control POSTs in, state fans out —
 * and EventSource reconnects on its own with no dependency to install.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import {
  getState, subscribe, applyPatch, setGoLive, nudgeTime, resetTime, setTarget, previewMode, sample,
} from './state.js';
import { geocode } from './geocode.js';
import { wallToUtc, utcToWall, formatLocal, zoneFor } from './time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7333);
// Bound to all interfaces by default so the panel opens on a phone — genuinely useful when
// you are at the location and the streaming machine is elsewhere. HOST=127.0.0.1 to restrict.
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** State as sent to clients. serverNow lets a client on another device correct its clock. */
const payload = () => {
  const s = getState();
  return { config: s.config, transition: s.transition, updatedAt: s.updatedAt, serverNow: Date.now() };
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(res, urlPath) {
  // Confine to public/ — normalize first so ../ cannot climb out.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([.][.][/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // The overlay must always reflect the file on disk after an edit + source refresh.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/') {
      res.writeHead(302, { Location: '/control' }).end();
      return;
    }
    if (path === '/overlay') return serveStatic(res, '/overlay.html');
    if (path === '/control') return serveStatic(res, '/control.html');

    /* ---------------- API ---------------- */

    if (path === '/api/state') return json(res, 200, payload());

    if (path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = () => res.write(`data: ${JSON.stringify(payload())}\n\n`);
      send();
      const unsubscribe = subscribe(send);
      const beat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(beat);
        unsubscribe();
      });
      return;
    }

    if (path === '/api/geocode') {
      const q = url.searchParams.get('q') || '';
      try {
        return json(res, 200, { results: await geocode(q) });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (path === '/api/delay') {
        const minutes = Number(body.minutes);
        if (!Number.isFinite(minutes)) return json(res, 400, { error: 'minutes must be a number' });
        nudgeTime(minutes);
        return json(res, 200, payload());
      }

      if (path === '/api/reset-time') {
        resetTime();
        return json(res, 200, payload());
      }

      if (path === '/api/time') {
        const s = getState();
        const zone = body.tz || s.config.target.tz;
        const ms = body.goLiveMs ?? wallToUtc(body.date, body.time, zone);
        if (!ms) return json(res, 400, { error: 'could not resolve that date/time in ' + zone });
        setGoLive(ms, body.forceMode || null);
        return json(res, 200, payload());
      }

      if (path === '/api/target') {
        const { name, lat, lon } = body;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json(res, 400, { error: 'lat/lon required' });
        }
        setTarget({ name, lat, lon, tz: body.tz || zoneFor(lat, lon) }, body.forceMode || null);
        return json(res, 200, payload());
      }

      if (path === '/api/config') {
        applyPatch(body.patch || {}, body.forceMode || null);
        return json(res, 200, payload());
      }

      if (path === '/api/preview-mode') {
        return json(res, 200, { mode: previewMode(body.patch || {}) });
      }
    }

    if (path === '/api/sample') {
      const s = getState();
      const ring = sample();
      return json(res, 200, {
        ...ring,
        localGoLive: formatLocal(s.config.goLiveMs, s.config.target.tz),
        localOriginal: formatLocal(s.config.originalGoLiveMs, s.config.target.tz),
        wall: utcToWall(s.config.goLiveMs, s.config.target.tz),
      });
    }

    return serveStatic(res, path);
  } catch (err) {
    console.error('[server]', err);
    json(res, 500, { error: err.message });
  }
});

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  const s = getState();
  console.log('');
  console.log('  ┌─ The Circle ─────────────────────────────────────────────');
  console.log('  │');
  console.log(`  │  OBS Browser Source   http://localhost:${PORT}/overlay?layout=full`);
  console.log(`  │  OBS Browser Dock     http://localhost:${PORT}/control`);
  if (lan && HOST !== '127.0.0.1') {
    console.log(`  │  Phone / tablet       http://${lan}:${PORT}/control`);
  }
  console.log('  │');
  console.log(`  │  Target   ${s.config.target.name}`);
  console.log(`  │  Go live  ${formatLocal(s.config.goLiveMs, s.config.target.tz)}`);
  console.log('  │');
  console.log('  └──────────────────────────────────────────────────────────');
  console.log('');
});
