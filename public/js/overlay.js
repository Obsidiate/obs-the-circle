/**
 * The Circle — OBS overlay.
 *
 * Draws a dark map, a closing wall of static, and the countdown. Every visual is derived
 * from ringAt(config, transition, now) — there is no animation state here, which is why a
 * mid-stream refresh or an OBS restart resumes exactly where it left off.
 */
import { Map as MaplibreMap } from '/vendor/maplibre-gl.mjs';
import { ringAt, zoomFor, formatCountdown, formatRadius, offsetLatLon, areaLabel } from './ring.js';
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
  smooth = new Float32Array(fx.width * fx.height);
}
window.addEventListener('resize', resize);

/** Previous frame's luma, for temporal smoothing. See paintStatic. */
let smooth = null;

// xorshift rather than Math.random: ~2x faster, and this runs per-pixel per-frame.
let rndState = 0x9e3779b9;
function rnd8() {
  rndState ^= rndState << 13;
  rndState ^= rndState >>> 17;
  rndState ^= rndState << 5;
  return (rndState >>> 24) & 0xff;
}

const M = CLOUD_N - 1;

/**
 * Paints one frame of slow, swirling fog into the low-res buffer.
 *
 * Three things make it read as drifting fog rather than TV static:
 *  - domain warping, where one sample of the cloud displaces the lookup of another. This
 *    is what produces curling, organic motion instead of a texture sliding in a straight
 *    line.
 *  - a small grain term rather than a dominant one; per-pixel white noise at 30fps is
 *    agitating to look at, and this sits on screen for hours.
 *  - temporal smoothing against the previous frame, which removes the strobe entirely and
 *    leaves everything flowing.
 */
function paintStatic(tMs, opacity) {
  const { width: w, height: h } = fx;
  const data = fxImage.data;
  const t = tMs / 1000;

  // Two drifts at different rates and directions so nothing ever visibly repeats.
  const dx = Math.round(t * 3.1) & M;
  const dy = Math.round(t * 2.0) & M;
  const wx = Math.round(t * 1.3) & M;
  const wy = Math.round(-t * 1.7) & M;
  const WARP = 0.5;

  for (let y = 0, i = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4, p++) {
      let c = 128;
      if (cloud) {
        // Coarse lookup (x>>1) gives a large, slow flow field; feeding it back in as an
        // offset is the domain warp that makes the fog curl.
        const u = ((x >> 1) + wx) & M;
        const v = ((y >> 1) + wy) & M;
        const ox = (cloud[v * CLOUD_N + u] - 128) * WARP;
        const oy = (cloud[((v + 137) & M) * CLOUD_N + ((u + 251) & M)] - 128) * WARP;
        c = cloud[(((y + dy + oy) | 0) & M) * CLOUD_N + (((x + dx + ox) | 0) & M)];
      }

      // Fog is luminous, not dark. At 40% over an already-dark map a near-black veil just
      // dims the frame and the swirl becomes invisible; lifting the luma is what lets the
      // motion actually read as moving fog.
      const target = 22 + (c >> 2) + (rnd8() >> 5);
      const s = smooth[p] * 0.76 + target * 0.24;
      smooth[p] = s;

      data[i] = s * 0.74;
      data[i + 1] = s * 0.9;
      data[i + 2] = s * 1.25;
      // Translucent, so the surrounding geography still reads as reference. Density
      // varies with the cloud, which stops it looking like a flat sheet of tint.
      data[i + 3] = opacity * (0.72 + (c / 255) * 0.28) * 255;
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

  paintStatic(tMs, state.veilOpacity);

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

  // Cyan bloom just inside the wall.
  vctx.globalCompositeOperation = 'lighter';
  const bloom = vctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r * 1.06);
  bloom.addColorStop(0, 'rgba(98,189,221,0)');
  bloom.addColorStop(0.72, 'rgba(98,189,221,0.16)');
  bloom.addColorStop(1, 'rgba(98,189,221,0)');
  vctx.fillStyle = bloom;
  vctx.beginPath();
  vctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2);
  vctx.fill();

  drawBoundary(cx, cy, r, tMs / 1000, state.phase === 'live');
  drawMotes(cx, cy, r, tMs / 1000);

  vctx.globalCompositeOperation = 'source-over';
  vctx.shadowBlur = 0;
}

/* ---------------------------------------------------------------- *
 * The boundary
 *
 * Three offset ribbons rather than one clean arc. Each undulates on its own slow phase,
 * so they cross and separate as they travel — that layering is what makes the edge writhe
 * instead of merely wobble. Frequencies are deliberately low: this sits on screen for
 * hours before a stream, so it has to stay calm to look at.
 * ---------------------------------------------------------------- */

const RIBBONS = [
  { amp: 0.030, width: 7.0, alpha: 0.13, phase: 0.0, blur: 30 },
  { amp: 0.014, width: 2.6, alpha: 0.85, phase: 2.1, blur: 22 },
  { amp: 0.008, width: 1.3, alpha: 0.95, phase: 4.3, blur: 10 },
];

const SEGMENTS = 220;

/** Radial displacement of the boundary at an angle, as a fraction of the radius. */
function writhe(theta, t, phase) {
  return (
    0.55 * Math.sin(3 * theta + t * 0.19 + phase) +
    0.30 * Math.sin(5 * theta - t * 0.14 + phase * 1.3) +
    0.15 * Math.sin(9 * theta + t * 0.09 + phase * 0.7)
  );
}

function drawBoundary(cx, cy, r, t, isLive) {
  const pulse = isLive ? 0.74 + 0.26 * Math.sin(t * 2.4) : 1;
  vctx.globalCompositeOperation = 'lighter';
  vctx.lineJoin = 'round';
  vctx.lineCap = 'round';

  for (const rib of RIBBONS) {
    vctx.beginPath();
    for (let i = 0; i <= SEGMENTS; i++) {
      const th = (i / SEGMENTS) * Math.PI * 2;
      const rr = r * (1 + rib.amp * writhe(th, t, rib.phase));
      const x = cx + rr * Math.cos(th);
      const y = cy + rr * Math.sin(th);
      if (i === 0) vctx.moveTo(x, y);
      else vctx.lineTo(x, y);
    }
    vctx.closePath();
    vctx.lineWidth = Math.max(1, rib.width * dpr);
    vctx.strokeStyle = `rgba(139,207,235,${rib.alpha * pulse})`;
    vctx.shadowBlur = rib.blur * dpr;
    vctx.shadowColor = 'rgba(98,189,221,0.9)';
    vctx.stroke();
  }
  vctx.shadowBlur = 0;
}

/**
 * Motes drifting along the boundary.
 *
 * Position and brightness are pure functions of (index, time) — no particle state is
 * stored, so a refreshed browser source produces the identical field rather than
 * re-seeding a visibly different one. Distributed by the golden angle so they never band.
 */
const MOTES = 110;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function drawMotes(cx, cy, r, t) {
  vctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < MOTES; i++) {
    // Varied orbital speeds, some retrograde, so the field never rotates as one body.
    const speed = 0.020 + 0.016 * Math.sin(i * 1.7);
    const th = i * GOLDEN + t * speed;

    // Drift in and out across the wall, on a slower cycle than the orbit.
    const band = Math.sin(t * 0.23 + i * 2.6) * 0.5 + Math.sin(t * 0.15 + i * 0.9) * 0.5;
    const rr = r * (1 + 0.055 * band);

    const twinkle = 0.5 + 0.5 * Math.sin(t * 0.7 + i * 2.1);
    const a = 0.1 + 0.62 * twinkle * twinkle;
    const size = (0.7 + 1.5 * twinkle) * dpr;

    vctx.beginPath();
    vctx.arc(cx + rr * Math.cos(th), cy + rr * Math.sin(th), size, 0, Math.PI * 2);
    vctx.fillStyle = `rgba(${150 + 60 * twinkle | 0},${215 + 30 * twinkle | 0},245,${a})`;
    vctx.fill();
  }
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

  // Deliberately the area ladder, never cfg.target.name — see areaLabel().
  const place = areaLabel(state.radiusM, cfg.target.area);
  el.sub.innerHTML =
    (place ? `${place}<span class="sep">·</span>` : '') +
    `<span class="scale">${formatRadius(state.radiusM)}</span>` +
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
      zoom: zoomFor(state.radiusM, state.centre.lat, w, h - reserve, 2.12, live.config.maxZoom ?? 16),
      padding: { top: 0, left: 0, right: 0, bottom: reserve },
    });
  }

  if (ts - lastStatic >= STATIC_INTERVAL) {
    lastStatic = ts;
    drawVeil({ ...state, veilOpacity: live.config.veilOpacity ?? 0.4 }, t);
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
