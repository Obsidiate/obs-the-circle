/**
 * The Circle — schedule maths.
 *
 * THE ONE RULE IN THIS FILE: every export is a pure function of its arguments.
 * No clock reads, no DOM, no module-level mutable state except the memo cache (which is
 * itself keyed purely on inputs). This is what makes the overlay refresh-safe, OBS-restart
 * -safe, and keeps the control panel's preview identical to what is on stream. If you are
 * tempted to bank an animation value in a variable here, don't — graft it into a
 * `transition` object instead (see applyTransition).
 */
import {
  hashSeed, mulberry32, makeWaves, waveAt,
  clamp01, smoothstep, lerp, easeInOutCubic,
} from './noise.js';

const METRES_PER_DEG_LAT = 111320;

/** Jitter fades out across this last slice of the run, for a calm final approach. */
const CALM_FROM = 0.9;

/** Resolution of the memoised cumulative-rate table. */
const TABLE_N = 512;

export const DEFAULT_CONFIG = {
  seed: 'sandridge',
  label: 'TONIGHT',
  target: {
    name: 'Sandridge Lookout, Port Melbourne',
    lat: -37.847337,
    lon: 144.9169414,
    tz: 'Australia/Melbourne',
    // Shown on the overlay in place of `name`, one rung at a time. See areaLabel().
    area: { suburb: 'Port Melbourne', city: 'Melbourne', state: 'Victoria', country: 'Australia' },
  },
  goLiveMs: 0,
  originalGoLiveMs: 0,
  windowMinutes: 360,
  startRadiusM: 1_500_000,
  // Roughly one city block in each direction. This is a treasure hunt, not a pin drop —
  // the circle should land you on the block and leave the rest to the viewer.
  endRadiusM: 250,
  jitter: 0.55,
  drift: 0.45,
  // Hard floor on how far the camera may close in. Paired with the label rules in the map
  // style, this is what stops the overlay from ever handing over a doorstep.
  maxZoom: 16,
  // The wall is translucent so the surrounding geography stays readable as reference.
  veilOpacity: 0.4,
};

/* ------------------------------------------------------------------ *
 * Shape: normalised progress along the log-radius journey.
 * ------------------------------------------------------------------ */

const tableCache = new Map();

/**
 * Builds a cumulative table of a noise-modulated closing *rate*.
 *
 * We perturb the rate and integrate rather than perturbing progress directly, because
 * integrating a strictly-positive rate guarantees the result is monotonically increasing.
 * A battle-royale ring never re-opens, and adding noise straight onto t would let it.
 * Memoised on (seed, jitter) — a pure function of both, so caching cannot break
 * determinism.
 */
function shapeTable(seed, jitter) {
  const key = `${seed}|${jitter}`;
  const hit = tableCache.get(key);
  if (hit) return hit;

  const waves = makeWaves(mulberry32(hashSeed(`${seed}:rate`)));
  const cum = new Float64Array(TABLE_N + 1);
  let acc = 0;
  for (let i = 0; i < TABLE_N; i++) {
    const s = (i + 0.5) / TABLE_N;
    const amp = jitter * (1 - smoothstep(CALM_FROM, 1, s));
    // |waveAt| <= 1 and amp < 1, so rate stays > 0 and the integral stays monotonic.
    acc += 1 + amp * waveAt(waves, s);
    cum[i + 1] = acc;
  }
  for (let i = 0; i <= TABLE_N; i++) cum[i] /= acc;

  tableCache.set(key, cum);
  return cum;
}

/** Normalised journey progress at time-fraction t. shape(0)=0, shape(1)=1, monotonic. */
export function shape(seed, jitter, t) {
  const cum = shapeTable(seed, jitter);
  const x = clamp01(t) * TABLE_N;
  const i = Math.min(TABLE_N - 1, Math.floor(x));
  return lerp(cum[i], cum[i + 1], x - i);
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Offset a lat/lon by a distance and bearing. Flat-earth approximation, fine at these scales. */
export function offsetLatLon(origin, bearingRad, distM) {
  const dLat = (distM * Math.cos(bearingRad)) / METRES_PER_DEG_LAT;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const dLon = (distM * Math.sin(bearingRad)) / (METRES_PER_DEG_LAT * Math.max(0.01, cosLat));
  return { lat: origin.lat + dLat, lon: origin.lon + dLon };
}

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const R = 6371008.8;
  const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ------------------------------------------------------------------ *
 * The schedule
 * ------------------------------------------------------------------ */

export function ringStartMs(cfg) {
  return cfg.goLiveMs - cfg.windowMinutes * 60_000;
}

/** Where the schedule alone says the ring should be — before any transition graft. */
export function scheduleAt(cfg, t) {
  const k = shape(cfg.seed, cfg.jitter, t);
  const radiusM = cfg.startRadiusM * Math.pow(cfg.endRadiusM / cfg.startRadiusM, k);

  // Centre starts offset by a fraction of the *current* radius (so the true target is
  // always inside the circle, just not at its middle) and converges by CALM_FROM.
  const frac = cfg.drift * (1 - smoothstep(0, CALM_FROM, t));
  if (frac <= 1e-6) return { radiusM, centre: { lat: cfg.target.lat, lon: cfg.target.lon } };

  const waves = makeWaves(mulberry32(hashSeed(`${cfg.seed}:angle`)), 3, 0.4, 1.6);
  const base = mulberry32(hashSeed(`${cfg.seed}:base`))() * Math.PI * 2;
  const bearing = base + waveAt(waves, t) * Math.PI;
  return { radiusM, centre: offsetLatLon(cfg.target, bearing, frac * radiusM) };
}

/**
 * Full ring state at an instant, including any in-flight transition.
 *
 * `transition` is a graft: the server samples {radiusM, centre} once at the moment a
 * config change lands and stores those numbers. Because they are stored rather than
 * live-animated, every client blends identically and a mid-run refresh is invisible.
 */
export function ringAt(cfg, transition, nowMs) {
  const startMs = ringStartMs(cfg);
  const span = Math.max(1, cfg.goLiveMs - startMs);
  const tRaw = (nowMs - startMs) / span;
  const t = clamp01(tRaw);

  const base = scheduleAt(cfg, t);
  let radiusM = base.radiusM;
  let centre = base.centre;
  let holding = false;

  if (transition) {
    const k = easeInOutCubic(clamp01((nowMs - transition.atMs) / transition.durationMs));

    if (k < 1) {
      radiusM = lerp(transition.fromRadiusM, base.radiusM, k);
      centre = {
        lat: lerp(transition.fromCentre.lat, base.centre.lat, k),
        lon: lerp(transition.fromCentre.lon, base.centre.lon, k),
      };
    }

    // 'absorb' forbids the circle from ever growing. On a delay the new schedule wants a
    // LARGER radius, so this clamp makes the ring visibly hold where it is until the
    // schedule catches back up — then it goes inert on its own. That is the "pause
    // slightly, then resume creeping" behaviour, and it needs no expiry logic.
    if (transition.mode === 'absorb' && radiusM > transition.fromRadiusM) {
      radiusM = transition.fromRadiusM;
      holding = base.radiusM > transition.fromRadiusM;
    }
  }

  const msToGoLive = cfg.goLiveMs - nowMs;
  const phase = nowMs < startMs ? 'pre' : msToGoLive > 0 ? 'closing' : 'live';

  return {
    radiusM,
    centre,
    t,
    tRaw,
    phase,
    holding,
    msToGoLive,
    delayMs: cfg.goLiveMs - cfg.originalGoLiveMs,
    base,
  };
}

/**
 * Builds the graft for a config change. Call at the instant the change lands, with the
 * OLD config, then persist the result alongside the new one.
 *
 * `absorb` keeps the run going (a delay, or a nudge within the current circle);
 * `reset` permits expansion, which is what produces the eased zoom back out to country
 * scale when the location moves somewhere genuinely different.
 */
export function makeTransition(oldCfg, oldTransition, newCfg, nowMs, forcedMode = null) {
  const before = ringAt(oldCfg, oldTransition, nowMs);
  const mode = forcedMode || classify(oldCfg, before, newCfg);
  return {
    atMs: nowMs,
    durationMs: mode === 'reset' ? 12_000 : 3_000,
    mode,
    fromRadiusM: before.radiusM,
    fromCentre: before.centre,
  };
}

/**
 * Small change -> absorb, big change -> reset.
 * "Small" means the new target is still inside the circle we are already showing and the
 * clock moved by less than an hour (or a quarter of the window, whichever is tighter).
 */
export function classify(oldCfg, before, newCfg) {
  if (before.phase === 'pre') return 'reset'; // nothing has started; no continuity to protect
  const moved = distanceM(oldCfg.target, newCfg.target);
  const shifted = Math.abs(newCfg.goLiveMs - oldCfg.goLiveMs);
  const timeBudget = Math.min(60 * 60_000, newCfg.windowMinutes * 60_000 * 0.25);
  return moved <= before.radiusM && shifted <= timeBudget ? 'absorb' : 'reset';
}

/* ------------------------------------------------------------------ *
 * Presentation helpers (still pure)
 * ------------------------------------------------------------------ */

/**
 * Web-mercator zoom that fits a circle of radiusM into the smaller viewport axis.
 *
 * `maxZoom` is the treasure-hunt floor: once the camera hits it the view stops closing in
 * and the circle simply shrinks within a fixed neighbourhood view. Without it the final
 * minutes would frame individual buildings and footpaths, which gives the location away
 * outright.
 */
export function zoomFor(radiusM, lat, width, height, padding = 2.6, maxZoom = 19) {
  const minAxis = Math.max(64, Math.min(width, height));
  const mpp = (radiusM * padding * 2) / minAxis;
  const worldMpp = 156543.03392 * Math.cos((lat * Math.PI) / 180);
  return Math.max(1, Math.min(maxZoom, Math.log2(worldMpp / mpp)));
}

/** "-00:04:12" past go-live, "02:14:37" before it. Always signed the same way a clock is. */
export function formatCountdown(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${neg ? '−' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * How much of the location to name, given how far the circle has closed.
 *
 * The overlay must never print the target itself — naming "Sandridge Lookout" ends the
 * hunt on the first frame. Instead it climbs a ladder in step with the camera: country,
 * then state, then city, and suburb + city as the floor. Each rung falls back to the one
 * above it when a place has no such division.
 */
export function areaLabel(radiusM, area = {}) {
  const { suburb, city, state, country } = area;
  const rungs =
    radiusM > 500_000 ? [country, state, city]
    : radiusM > 100_000 ? [state, country, city]
    : radiusM > 5_000 ? [city, state, country]
    : [[suburb, city].filter(Boolean).join(' · '), city, state, country];
  return rungs.find((r) => r) || '';
}

/** "1,500 km" / "820 m" — the scale readout under the ring. */
export function formatRadius(m) {
  if (m >= 100_000) return `${Math.round(m / 1000).toLocaleString()} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}
