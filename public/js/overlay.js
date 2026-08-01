/**
 * The Circle — OBS overlay.
 *
 * Draws a dark map, a closing wall of static, and the countdown. Every visual is derived
 * from ringAt(config, transition, now) — there is no animation state here, which is why a
 * mid-stream refresh or an OBS restart resumes exactly where it left off.
 */
import { Map as MaplibreMap } from '/vendor/maplibre-gl.mjs';
import { ringAt, zoomFor, formatCountdown, formatRadius, offsetLatLon } from './ring.js';
import { connect, now, layout, digitize } from './client-state.js';

const stage = document.getElementById('stage');
const veil = document.getElementById('veil');
const vctx = veil.getContext('2d');
const el = {
  eyebrow: document.getElementById('eyebrow'),
  clock: document.getElementById('clock'),
  sub: document.getElementById('sub'),
  delay: document.getElementById('delay'),
};

document.body.classList.add(layout);

/* ---------------------------------------------------------------- *
 * Map
 * ---------------------------------------------------------------- */

const map = new MaplibreMap({
  container: 'map',
  style: '/vendor/style-dark.json',
  center: [144.9169414, -37.847337],
  zoom: 4,
  interactive: false,       // an OBS source must never be draggable
  attributionControl: false, // we render our own, see #attrib
  fadeDuration: 0,          // labels crossfading during a continuous zoom looks like a glitch
  refreshExpiredTiles: false,
});

// If tiles never arrive we still want ring + timer over brand ink, never a blank frame.
map.on('error', (e) => console.warn('[map]', e?.error?.message || e));

/* ---------------------------------------------------------------- *
 * The static
 *
 * Built from the same feTurbulence fractalNoise the website uses for its ambient film
 * grain — this is that grain turned up. A soft cloud layer (sampled once, then drifted)
 * carries the shape; per-frame random grain sells it as dead signal.
 * ---------------------------------------------------------------- */

const CLOUD_N = 512;
const CLOUD_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CLOUD_N}" height="${CLOUD_N}">` +
  '<filter id="c">' +
  '<feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" stitchTiles="stitch"/>' +
  '<feColorMatrix type="saturate" values="0"/>' +
  '</filter>' +
  '<rect width="100%" height="100%" filter="url(#c)"/></svg>';

/** Luminance of one tile of cloud, sampled once at load. */
let cloud = null;

function buildCloud() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = CLOUD_N;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const src = cx.getImageData(0, 0, CLOUD_N, CLOUD_N).data;
      const lum = new Uint8Array(CLOUD_N * CLOUD_N);
      for (let i = 0; i < lum.length; i++) lum[i] = src[i * 4];
      resolve(lum);
    };
    img.onerror = () => resolve(null); // degrade to pure grain rather than failing
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(CLOUD_SVG);
  });
}

// Static is generated at quarter resolution and upscaled. Full-res per-pixel noise is the
// classic way to melt a CPU inside an OBS browser source; at 1/4 it is invisible in the
// blur and roughly 16x cheaper.
const SCALE = 4;
const fx = document.createElement('canvas');
const fxctx = fx.getContext('2d', { willReadFrequently: true });
let fxImage = null;

let dpr = 1;
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  veil.width = Math.round(w * dpr);
  veil.height = Math.round(h * dpr);
  veil.style.width = w + 'px';
  veil.style.height = h + 'px';

  fx.width = Math.max(2, Math.round(veil.width / SCALE));
  fx.height = Math.max(2, Math.round(veil.height / SCALE));
  fxImage = fxctx.createImageData(fx.width, fx.height);
}
window.addEventListener('resize', resize);

// xorshift rather than Math.random: ~2x faster, and this runs per-pixel per-frame.
let rndState = 0x9e3779b9;
function rnd8() {
  rndState ^= rndState << 13;
  rndState ^= rndState >>> 17;
  rndState ^= rndState << 5;
  return (rndState >>> 24) & 0xff;
}

/** Paints one frame of cloudy static into the low-res buffer. */
function paintStatic(tMs, intensity) {
  const { width: w, height: h } = fx;
  const data = fxImage.data;

  // Slow drift, so the cloud breathes instead of sitting still.
  const dx = Math.round((tMs / 90) % CLOUD_N);
  const dy = Math.round((tMs / 140) % CLOUD_N);

  for (let y = 0, i = 0; y < h; y++) {
    const cy = ((y + dy) & (CLOUD_N - 1)) * CLOUD_N;
    for (let x = 0; x < w; x++, i += 4) {
      const c = cloud ? cloud[cy + ((x + dx) & (CLOUD_N - 1))] : 128;
      const grain = rnd8();
      // Near-ink with a hard grain: this is dead signal, not fog. The wall must stay
      // DARKER than the map inside it, or the eye goes to the thing that is hiding the
      // answer instead of the thing revealing it. Low base + a wide grain term gives a
      // dark wall that still visibly crawls.
      const v = 4 + (c >> 4) + (grain >> 3);
      data[i] = v * 0.78;
      data[i + 1] = v * 0.92;
      data[i + 2] = v * 1.2;
      // Opaque. The wall's job is to hide where you are, so it must not be see-through.
      data[i + 3] = 255 * intensity;
    }
  }
  fxctx.putImageData(fxImage, 0, 0);
}

/** Pixel radius of a ground distance at the map's current camera. */
function radiusPx(centre, radiusM) {
  const a = map.project([centre.lon, centre.lat]);
  const edge = offsetLatLon(centre, 0, radiusM); // due north
  const b = map.project([edge.lon, edge.lat]);
  return Math.hypot(b.x - a.x, b.y - a.y) * dpr;
}

function drawVeil(state, tMs) {
  const W = veil.width;
  const H = veil.height;
  if (!W || !H) return;

  paintStatic(tMs, 1);

  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, W, H);

  // Upscaled with smoothing: the interpolation is what turns 1/4-res noise into a soft
  // cloud rather than visible chunky pixels.
  vctx.globalCompositeOperation = 'source-over';
  vctx.imageSmoothingEnabled = true;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(fx, 0, 0, W, H);

  const p = map.project([state.centre.lon, state.centre.lat]);
  const cx = p.x * dpr;
  const cy = p.y * dpr;
  const r = Math.max(1, radiusPx(state.centre, state.radiusM));

  // Punch the safe zone out. The feathered inner stop is what makes the boundary look
  // like encroaching interference instead of a cookie-cutter hole.
  const feather = Math.max(0.55, 1 - 90 / Math.max(90, r));
  const hole = vctx.createRadialGradient(cx, cy, r * feather, cx, cy, r);
  hole.addColorStop(0, 'rgba(0,0,0,1)');
  hole.addColorStop(0.75, 'rgba(0,0,0,0.82)');
  hole.addColorStop(1, 'rgba(0,0,0,0)');
  vctx.globalCompositeOperation = 'destination-out';
  vctx.fillStyle = hole;
  vctx.beginPath();
  vctx.arc(cx, cy, r, 0, Math.PI * 2);
  vctx.fill();

  // Cyan bloom just inside the wall, then the boundary stroke itself — the same round-cap,
  // glowing cyan "ink" treatment as the underline on the website.
  vctx.globalCompositeOperation = 'lighter';
  const bloom = vctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r * 1.06);
  bloom.addColorStop(0, 'rgba(98,189,221,0)');
  bloom.addColorStop(0.72, 'rgba(98,189,221,0.16)');
  bloom.addColorStop(1, 'rgba(98,189,221,0)');
  vctx.fillStyle = bloom;
  vctx.beginPath();
  vctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2);
  vctx.fill();

  vctx.globalCompositeOperation = 'source-over';
  const pulse = state.phase === 'live' ? 0.72 + 0.28 * Math.sin(tMs / 320) : 1;
  vctx.lineWidth = Math.max(1.5, 2.4 * dpr);
  vctx.strokeStyle = `rgba(139,207,235,${0.92 * pulse})`;
  vctx.shadowBlur = 26 * dpr;
  vctx.shadowColor = 'rgba(98,189,221,0.95)';
  vctx.beginPath();
  vctx.arc(cx, cy, r, 0, Math.PI * 2);
  vctx.stroke();
  vctx.shadowBlur = 0;
}

/* ---------------------------------------------------------------- *
 * HUD
 * ---------------------------------------------------------------- */

const fmtLocal = (ms, tz) =>
  new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
  })
    .format(new Date(ms))
    .replace(/\b(am|pm)\b/, (m) => m.toUpperCase());

function drawHud(cfg, state) {
  const overdue = state.msToGoLive < 0;
  const delayed = Math.abs(state.delayMs) >= 60_000;

  el.clock.innerHTML = digitize(formatCountdown(state.msToGoLive));
  el.clock.className = overdue ? 'alert' : delayed ? 'warn' : '';
  el.eyebrow.className = 'eyebrow ' + (overdue ? 'alert' : delayed ? 'warn' : '');
  el.eyebrow.textContent = overdue ? 'Running late' : state.holding ? 'Circle holding' : 'Until live';

  const place = (cfg.target.name || '').split(',')[0];
  el.sub.innerHTML =
    `${place}<span class="sep">·</span><span class="scale">${formatRadius(state.radiusM)}</span>` +
    `<span class="sep">·</span>${fmtLocal(cfg.goLiveMs, cfg.target.tz)}`;

  if (delayed) {
    const mins = Math.round(state.delayMs / 60_000);
    const sign = mins > 0 ? '+' : '−';
    el.delay.textContent =
      `${mins > 0 ? 'Delayed' : 'Brought forward'} ${sign}${Math.abs(mins)} min · now ${fmtLocal(cfg.goLiveMs, cfg.target.tz)}`;
    el.delay.hidden = false;
  } else {
    el.delay.hidden = true;
  }
}

/* ---------------------------------------------------------------- *
 * Loop
 *
 * Static animates at ~30fps and the camera updates at ~10fps. Over a six-hour window the
 * zoom moves ~0.00001 levels per frame, so driving the camera every frame would burn GPU
 * re-rendering a view no one can tell apart.
 * ---------------------------------------------------------------- */

const STATIC_INTERVAL = 1000 / 30;
const CAMERA_INTERVAL = 1000 / 10;

let live = null;
let lastStatic = 0;
let lastCamera = 0;

connect({ onState: (p) => { live = p; } });

function frame(ts) {
  requestAnimationFrame(frame);
  if (!live || !cloudReady) return;

  const t = now();
  const state = ringAt(live.config, live.transition, t);

  if (ts - lastCamera >= CAMERA_INTERVAL) {
    lastCamera = ts;
    // Reserve the lower band for the HUD and centre the circle in what's left, so the
    // countdown never sits on top of the map.
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const reserve = h * (layout === 'panel' ? 0.34 : 0.28);
    map.jumpTo({
      center: [state.centre.lon, state.centre.lat],
      zoom: zoomFor(state.radiusM, state.centre.lat, w, h - reserve, 2.12),
      padding: { top: 0, left: 0, right: 0, bottom: reserve },
    });
  }

  if (ts - lastStatic >= STATIC_INTERVAL) {
    lastStatic = ts;
    drawVeil(state, t);
  }

  drawHud(live.config, state);
}

let cloudReady = false;
resize();
buildCloud().then((lum) => {
  cloud = lum;
  cloudReady = true;
});
requestAnimationFrame(frame);
