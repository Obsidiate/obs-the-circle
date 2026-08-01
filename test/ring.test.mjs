import { ringAt, scheduleAt, shape, makeTransition, DEFAULT_CONFIG, distanceM, formatCountdown, formatRadius, zoomFor, areaLabel }
  from '../public/js/ring.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL:', msg); fails++; } };

const T0 = 1_800_000_000_000;
const cfg = { ...DEFAULT_CONFIG, goLiveMs: T0, originalGoLiveMs: T0 };
const start = T0 - cfg.windowMinutes * 60_000;

// 1. shape endpoints + monotonicity
ok(Math.abs(shape(cfg.seed, cfg.jitter, 0)) < 1e-9, 'shape(0) must be 0');
ok(Math.abs(shape(cfg.seed, cfg.jitter, 1) - 1) < 1e-9, 'shape(1) must be 1');

let prev = Infinity, prevShape = -1, nonMono = 0;
for (let i = 0; i <= 2000; i++) {
  const t = i / 2000;
  const s = shape(cfg.seed, cfg.jitter, t);
  if (s < prevShape - 1e-12) nonMono++;
  prevShape = s;
  const r = scheduleAt(cfg, t).radiusM;
  if (r > prev + 1e-6) nonMono++;
  prev = r;
}
ok(nonMono === 0, `radius/shape must be monotonic (violations: ${nonMono})`);

// 2. endpoints of radius
ok(Math.abs(scheduleAt(cfg, 0).radiusM - cfg.startRadiusM) < 1, 'radius(0) = startRadius');
ok(Math.abs(scheduleAt(cfg, 1).radiusM - cfg.endRadiusM) < 0.01, 'radius(1) = endRadius');

// 3. jitter actually does something (should deviate from a pure log ramp mid-run)
let maxDev = 0;
for (let i = 1; i < 100; i++) {
  const t = i / 100;
  maxDev = Math.max(maxDev, Math.abs(shape(cfg.seed, cfg.jitter, t) - t));
}
ok(maxDev > 0.02, `jitter should visibly deviate from linear (max dev ${maxDev.toFixed(4)})`);

// 4. jitter is calm in the final 10%
let lateDev = 0;
for (let i = 90; i <= 100; i++) {
  const t = i / 100;
  lateDev = Math.max(lateDev, Math.abs(shape(cfg.seed, cfg.jitter, t) - shape(cfg.seed, 0, t)));
}
const earlyDev = Math.abs(shape(cfg.seed, cfg.jitter, 0.5) - 0.5);
ok(lateDev < earlyDev, `final 10% must be calmer than mid-run (late ${lateDev.toFixed(4)} vs mid ${earlyDev.toFixed(4)})`);

// 5. true target always inside the circle while drifting
let outside = 0, maxFrac = 0;
for (let i = 0; i <= 1000; i++) {
  const t = i / 1000;
  const { radiusM, centre } = scheduleAt(cfg, t);
  const d = distanceM(centre, cfg.target);
  maxFrac = Math.max(maxFrac, d / radiusM);
  if (d > radiusM) outside++;
}
ok(outside === 0, `target must stay inside the circle (${outside} violations, max frac ${maxFrac.toFixed(3)})`);

// 6. centre converges by t=0.9
ok(distanceM(scheduleAt(cfg, 0.9).centre, cfg.target) < 1, 'centre converged by t=0.9');
ok(distanceM(scheduleAt(cfg, 0.3).centre, cfg.target) > 1000, 'centre still offset at t=0.3');

// 7. THE DELAY CASE: +30 min at t=0.5 must HOLD, never grow
const mid = start + (T0 - start) * 0.5;
const before = ringAt(cfg, null, mid);
const delayed = { ...cfg, goLiveMs: T0 + 30 * 60_000 };
const tr = makeTransition(cfg, null, delayed, mid);
ok(tr.mode === 'absorb', `+30min should absorb, got ${tr.mode}`);

let grew = 0, held = 0, sampled = 0;
let prevR = before.radiusM;
for (let ms = mid; ms < mid + 45 * 60_000; ms += 5000) {
  const st = ringAt(delayed, tr, ms);
  if (st.radiusM > prevR + 1e-6) grew++;
  if (st.holding) held++;
  prevR = st.radiusM;
  sampled++;
}
ok(grew === 0, `absorb must never grow the circle (${grew} growth steps)`);
ok(held > 0, `absorb should report holding while the schedule catches up (held ${held}/${sampled})`);
// and it must eventually resume shrinking
const resumed = ringAt(delayed, tr, mid + 44 * 60_000);
ok(!resumed.holding, 'hold must release once the schedule catches up');
ok(resumed.radiusM < before.radiusM, 'must be shrinking again after the hold');

// 8. continuity: no jump at the instant of the graft
const atChange = ringAt(delayed, tr, mid);
ok(Math.abs(atChange.radiusM - before.radiusM) < 1e-6, 'no radius jump at the graft instant');

// 9. big relocation -> reset, and expansion is permitted
const moved = { ...cfg, target: { ...cfg.target, lat: -33.87, lon: 151.21, name: 'Sydney' } };
const tr2 = makeTransition(cfg, null, moved, mid);
ok(tr2.mode === 'reset', `interstate move should reset, got ${tr2.mode}`);
const after2 = ringAt(moved, tr2, mid + 12_000);
ok(after2.radiusM >= before.radiusM * 0.99, 'reset should be free to expand back out');

// 10. determinism: same inputs -> identical outputs
const a = ringAt(delayed, tr, mid + 12345);
const b = ringAt(delayed, tr, mid + 12345);
ok(a.radiusM === b.radiusM && a.centre.lat === b.centre.lat, 'must be deterministic');

// 11. overdue counts negative
const late = ringAt(cfg, null, T0 + 252_000);
ok(late.phase === 'live', 'phase live past go-live');
ok(late.msToGoLive < 0, 'msToGoLive negative past go-live');
ok(formatCountdown(late.msToGoLive) === '−00:04:12', `overdue format, got ${formatCountdown(late.msToGoLive)}`);

// 12. pre-window clamp
const early = ringAt(cfg, null, start - 5 * 3600_000);
ok(early.phase === 'pre', 'phase pre before the window');
ok(Math.abs(early.radiusM - cfg.startRadiusM) < 1, 'clamped to start radius before the window');

// 13. formatting + zoom sanity
ok(formatRadius(1_500_000) === '1,500 km', formatRadius(1_500_000));
ok(formatRadius(120) === '120 m', formatRadius(120));
const zStart = zoomFor(1_500_000, -37.8, 1920, 1080);
const zEnd = zoomFor(120, -37.8, 1920, 1080);
ok(zStart > 2 && zStart < 6, `country zoom ~3-5, got ${zStart.toFixed(2)}`);
ok(zEnd > 14 && zEnd < 18, `lookout zoom ~15-17, got ${zEnd.toFixed(2)}`);


// 14. treasure-hunt floor: the camera must stop closing in at maxZoom
const zCapped = zoomFor(cfg.endRadiusM, -37.8, 1920, 1080, 2.12, cfg.maxZoom);
ok(zCapped === cfg.maxZoom, `final zoom must clamp to maxZoom (${cfg.maxZoom}), got ${zCapped}`);
ok(zoomFor(1, -37.8, 1920, 1080, 2.12, 16) === 16, 'even an absurd radius cannot exceed maxZoom');
ok(zoomFor(1_500_000, -37.8, 1920, 1080, 2.12, 16) < 6, 'country scale unaffected by the cap');
// and the cap must not stop the circle itself from shrinking
ok(scheduleAt(cfg, 1).radiusM === cfg.endRadiusM, 'circle still reaches endRadius under the zoom cap');
ok(cfg.endRadiusM >= 100, 'endRadius stays block-scale, not doorstep-scale');


// 15. the area ladder: country -> state -> city -> suburb+city, and never the venue name
const AREA = DEFAULT_CONFIG.target.area;
ok(areaLabel(1_500_000, AREA) === 'Australia', 'country at country scale');
ok(areaLabel(400_000, AREA) === 'Victoria', 'state next');
ok(areaLabel(60_000, AREA) === 'Melbourne', 'city next');
ok(areaLabel(250, AREA) === 'Port Melbourne · Melbourne', 'suburb + city is the floor');
// the ladder must be monotonic: never show a finer rung at a wider radius
const rungs = [1_500_000, 400_000, 60_000, 250].map((r) => areaLabel(r, AREA));
ok(new Set(rungs).size === 4, 'each scale gets a distinct rung');
// the venue name must never appear at any radius
let leaked = 0;
for (let r = 100; r < 2_000_000; r = Math.ceil(r * 1.15)) {
  if (areaLabel(r, AREA).includes('Sandridge')) leaked++;
}
ok(leaked === 0, `the target's own name must never be shown (leaked at ${leaked} radii)`);
// graceful when a place has no suburb or state
ok(areaLabel(250, { city: 'Reykjavik', country: 'Iceland' }) === 'Reykjavik', 'falls back when no suburb');
ok(areaLabel(1_500_000, { city: 'Reykjavik', country: 'Iceland' }) === 'Iceland', 'falls back to country');
ok(areaLabel(250, {}) === '', 'empty area yields no label rather than undefined');

console.log(`\nzoom range: ${zStart.toFixed(2)} -> ${zEnd.toFixed(2)}`);
console.log(`max drift fraction of radius: ${maxFrac.toFixed(3)}`);
console.log(fails === 0 ? '\nALL RING TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
