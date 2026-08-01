/**
 * Nominatim client, kept deliberately inside the OSM usage policy:
 *   - only fires on an explicit search in the control panel, never on a timer
 *   - serialised to at most 1 request/second
 *   - results cached to disk, so repeat searches never hit the network again
 *   - identifying User-Agent (a stock library UA gets you blocked)
 * https://operations.osmfoundation.org/policies/nominatim/
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zoneFor } from './time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = join(ROOT, 'cache', 'geocode.json');
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const UA = 'obs-the-circle/0.1 (OBS stream overlay; https://github.com/Obsidiate/obs-the-circle)';
const MIN_INTERVAL_MS = 1100;

let cache = null;
let lastRequestAt = 0;
// Gate for the 1-req/s serialisation. Kept separate from the returned promise and always
// resolved, so one failed lookup cannot permanently wedge every later search behind a
// rejected chain.
let gate = Promise.resolve();

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  } catch (err) {
    console.warn('[geocode] could not write cache:', err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Search for a place. Returns [{name, lat, lon, tz}], most relevant first.
 * Rate-limited by chaining onto a single promise queue, so concurrent callers still
 * go out one-per-second rather than in a burst.
 */
export function geocode(query) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);

  const store = loadCache();
  const key = q.toLowerCase();
  if (store[key]) return Promise.resolve(store[key]);

  const run = gate.then(async () => {
    if (store[key]) return store[key]; // filled in while we waited our turn

    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=0`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);

    const results = (await res.json()).map((r) => {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      return {
        name: r.name || r.display_name.split(',')[0], // what the overlay shows
        full: r.display_name,                          // disambiguates in the results list
        lat,
        lon,
        tz: zoneFor(lat, lon),
      };
    });

    store[key] = results;
    saveCache();
    return results;
  });

  gate = run.catch(() => {});
  return run;
}

/**
 * Reverse-geocode to administrative areas: {suburb, city, state, country}.
 *
 * The overlay never prints the target's own name — "Sandridge Lookout" would simply hand
 * the answer over. It shows a rung of this ladder instead, chosen by how far the circle
 * has closed. zoom=14 asks Nominatim for suburb-level granularity rather than the exact
 * feature.
 */
export function reverseArea(lat, lon) {
  const key = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const store = loadCache();
  if (store[key]) return Promise.resolve(store[key]);

  const run = gate.then(async () => {
    if (store[key]) return store[key];

    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const url = `${ENDPOINT.replace('/search', '/reverse')}?lat=${lat}&lon=${lon}&format=json&zoom=14&addressdetails=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Nominatim reverse ${res.status}`);

    const a = (await res.json()).address || {};
    const area = {
      suburb: a.suburb || a.neighbourhood || a.quarter || a.village || a.town || null,
      city: a.city || a.town || a.municipality || a.county || null,
      state: a.state || a.province || a.region || null,
      country: a.country || null,
    };
    store[key] = area;
    saveCache();
    return area;
  });

  gate = run.catch(() => {});
  return run;
}
