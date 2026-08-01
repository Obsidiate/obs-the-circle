/**
 * Authoritative state: the config every client renders from, plus the transition graft
 * that keeps changes smooth.
 *
 * The server is the only place allowed to *sample* the current ring (in makeTransition).
 * Clients only ever render. That single-sampler rule is what stops two browser sources
 * from disagreeing about where the circle was when a change landed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, makeTransition, ringAt } from '../public/js/ring.js';
import { nextOccurrence, zoneFor } from './time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, 'state.json');

let state = null;
const listeners = new Set();

function freshState() {
  const tz = DEFAULT_CONFIG.target.tz;
  const goLive = nextOccurrence('21:30', tz);
  return {
    config: { ...DEFAULT_CONFIG, goLiveMs: goLive, originalGoLiveMs: goLive },
    transition: null,
    updatedAt: Date.now(),
  };
}

export function getState() {
  if (state) return state;
  try {
    const loaded = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // Merge over defaults so a state file written by an older version still boots.
    state = { ...freshState(), ...loaded, config: { ...DEFAULT_CONFIG, ...loaded.config } };
  } catch {
    state = freshState();
  }
  return state;
}

function persist() {
  state.updatedAt = Date.now();
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch (err) {
    console.warn('[state] could not persist:', err.message);
  }
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a dead SSE client must not take down the broadcast */
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Apply a config patch, grafting a transition so the circle never jumps.
 *
 * @param patch      partial config
 * @param forceMode  'absorb' | 'reset' | null (null = auto-classify)
 */
export function applyPatch(patch, forceMode = null) {
  const s = getState();
  const oldCfg = s.config;
  const newCfg = { ...oldCfg, ...patch };

  // A new location gets a new closure pattern — each night should creep differently.
  // Deliberately not re-seeded on a delay, which must not disturb the shape mid-run.
  if (patch.target && patch.target.name !== oldCfg.target.name) {
    newCfg.seed = `${patch.target.name}|${Date.now().toString(36)}`;
  }

  s.transition = makeTransition(oldCfg, s.transition, newCfg, Date.now(), forceMode);
  s.config = newCfg;
  persist();
  return s;
}

/** Set a brand-new go-live. Clears any accumulated delay — this is a fresh schedule. */
export function setGoLive(goLiveMs, forceMode = null) {
  return applyPatch({ goLiveMs, originalGoLiveMs: goLiveMs }, forceMode);
}

/**
 * Push (or pull) the clock while keeping the run going. `originalGoLiveMs` is untouched,
 * which is what drives the DELAYED banner and lets delays accumulate into one total.
 */
export function nudgeTime(minutes) {
  const s = getState();
  return applyPatch({ goLiveMs: s.config.goLiveMs + minutes * 60_000 }, 'absorb');
}

/** Back to the originally announced time. */
export function resetTime() {
  const s = getState();
  return applyPatch({ goLiveMs: s.config.originalGoLiveMs }, 'absorb');
}

/** Move the target, resolving its timezone from the coordinate. */
export function setTarget(target, forceMode = null) {
  return applyPatch({ target: { ...target, tz: target.tz || zoneFor(target.lat, target.lon) } }, forceMode);
}

/** What the classifier *would* do, so the control panel can warn before you commit. */
export function previewMode(patch) {
  const s = getState();
  const t = makeTransition(s.config, s.transition, { ...s.config, ...patch }, Date.now());
  return t.mode;
}

/** Current ring, for the control panel readout. */
export function sample(nowMs = Date.now()) {
  const s = getState();
  return ringAt(s.config, s.transition, nowMs);
}
