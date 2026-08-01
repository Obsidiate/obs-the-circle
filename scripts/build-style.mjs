/**
 * Generates public/vendor/style-dark.json from OpenFreeMap's positron style.
 *
 * Why derive rather than vendor an off-the-shelf dark style: OpenFreeMap ships
 * liberty/bright/positron and no dark option. Deriving from one of their own styles
 * guarantees the layer/source schema matches the tiles they actually serve, and lets us
 * pull the palette toward WIM brand ink + cyan instead of a generic grey.
 *
 * Run: npm run build:style   (only needed when refreshing against upstream)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = 'https://tiles.openfreemap.org/styles/positron';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'style-dark.json');

// Brand anchors (from wroteitmyself.com)
const INK = '#060608';
const BRAND_HUE = 193; // the logo cyan, #62BDDD

/* ---------- colour parsing ---------- */

function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  if ((m = s.match(/^rgba?\(([^)]+)\)$/i))) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  if ((m = s.match(/^hsla?\(([^)]+)\)$/i))) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length < 3) return null;
    const { r, g, b } = hslToRgb(p[0] / 360, p[1] / 100, p[2] / 100);
    return { r, g, b, a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { r: f(0), g: f(8), b: f(4) };
}

const css = ({ r, g, b, a }) =>
  a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;

/**
 * Invert lightness into a dark range and pull the hue toward brand cyan.
 * Positron is a light basemap, so near-white land becomes near-black ink and its
 * faint hairlines become the lightest things on the map — which is what makes a dark
 * basemap readable rather than just dimmed.
 */
function darken(color, { floor = 0.035, ceil = 0.42, sat = 0.5, pull = 0.3 } = {}) {
  const { h, s, l } = rgbToHsl(color);
  const nl = floor + (1 - l) * (ceil - floor);
  const ns = Math.min(s * sat, 0.4);
  // move hue a fraction of the way toward brand cyan, on the short arc
  const target = BRAND_HUE / 360;
  let dh = target - h;
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  const nh = (h + dh * pull + 1) % 1;
  return { ...hslToRgb(nh, ns, nl), a: color.a };
}

/* ---------- recursive walk over paint/layout values ---------- */

const COLOR_KEY = /(^|-)color$/;

function mapColors(value, fn) {
  if (typeof value === 'string') {
    const c = parseColor(value);
    return c ? css(fn(c)) : value;
  }
  if (Array.isArray(value)) return value.map((v) => mapColors(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapColors(v, fn);
    return out;
  }
  return value;
}

/* ---------- build ---------- */

const res = await fetch(SRC);
if (!res.ok) throw new Error(`Failed to fetch ${SRC}: ${res.status}`);
const style = await res.json();

style.name = 'WIM Ring Dark';
style.metadata = {
  ...(style.metadata || {}),
  'wim:derived-from': SRC,
  'wim:note': 'Lightness-inverted and hue-pulled toward brand cyan. Regenerate with npm run build:style.',
};

// The natural-earth shaded-relief raster is a light-mode asset and dominates the
// country-scale view we open on. Vector landcover carries z3-6 fine without it.
delete style.sources.ne2_shaded;
style.layers = style.layers.filter((l) => l.source !== 'ne2_shaded');

/**
 * Explicit palette rather than blind inversion.
 *
 * Inverting positron wholesale does the wrong thing to roads: on a light basemap the land
 * is light grey and the roads are *white*, so flipping lightness makes roads darker than
 * the land they sit on and the whole street network disappears. A dark basemap needs roads
 * brighter than land, which is a re-mapping, not a flip.
 */
const P = {
  land: 'rgb(16, 18, 23)',
  water: 'rgb(6, 10, 17)',
  waterway: 'rgb(22, 36, 50)',
  park: 'rgb(13, 22, 19)',
  wood: 'rgb(12, 19, 16)',
  ice: 'rgb(26, 32, 40)',
  landuse: 'rgb(20, 22, 28)',
  building: 'rgb(27, 30, 37)',
  roadCasing: 'rgb(11, 13, 17)',
  roadPath: 'rgb(30, 34, 41)',
  roadMinor: 'rgb(40, 45, 54)',
  roadMajor: 'rgb(58, 65, 77)',
  roadHighway: 'rgb(76, 85, 99)',
  aeroway: 'rgb(31, 35, 43)',
  boundary: 'rgb(66, 74, 88)',
  text: 'rgb(150, 158, 170)',
  textMajor: 'rgb(214, 220, 228)',
  halo: 'rgb(5, 5, 9)',
};

/** Flat colour for a layer, or null to fall through to the generic darkener. */
function paletteFor(layer, prop) {
  const id = layer.id;
  const src = layer['source-layer'];

  if (prop.includes('halo')) return P.halo;
  if (layer.type === 'symbol') {
    return /country|state|city_capital|^label_city/.test(id) ? P.textMajor : P.text;
  }

  if (id === 'background') return P.land;
  if (src === 'water') return P.water;
  if (src === 'waterway') return P.waterway;
  if (src === 'park') return P.park;
  if (src === 'landuse') return P.landuse;
  if (src === 'building') return P.building;
  if (src === 'boundary') return P.boundary;
  if (src === 'aeroway') return P.aeroway;
  if (src === 'landcover') return /ice|glacier/.test(id) ? P.ice : P.wood;

  if (src === 'transportation') {
    if (/casing/.test(id)) return P.roadCasing;
    if (/pier|area/.test(id)) return P.landuse;
    if (/motorway|trunk/.test(id)) return P.roadHighway;
    if (/major|primary|secondary/.test(id)) return P.roadMajor;
    if (/path|track|footway/.test(id)) return P.roadPath;
    return P.roadMinor;
  }
  return null;
}

for (const layer of style.layers) {
  for (const bucket of ['paint', 'layout']) {
    if (!layer[bucket]) continue;
    for (const [prop, val] of Object.entries(layer[bucket])) {
      if (!COLOR_KEY.test(prop)) continue;
      const flat = paletteFor(layer, prop);
      // Flattening any zoom/class expression to one colour is deliberate: it gives the
      // overlay a consistent look across the whole 13-zoom-level journey. Widths and
      // opacities keep their expressions, so the map still gains detail as it closes in.
      layer[bucket][prop] = flat ?? mapColors(val, (c) => darken(c));
    }
  }
}

writeFileSync(OUT, JSON.stringify(style, null, 1));
console.log(`wrote ${OUT}`);
console.log(`layers: ${style.layers.length}, sources: ${Object.keys(style.sources).join(', ')}`);
