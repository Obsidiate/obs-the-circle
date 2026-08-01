/**
 * The Circle — control panel.
 *
 * Renders the same ringAt() the overlay does, so the readout here is exactly what is on
 * stream rather than an approximation. All mutations go through the server, which is the
 * only thing allowed to sample the ring and graft a transition.
 */
import { ringAt, formatCountdown, formatRadius } from './ring.js';
import { connect, now, post, digitize } from './client-state.js';

const $ = (id) => document.getElementById(id);
let live = null;

/* ---------------- toast ---------------- */

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2600);
}

/** Wraps an action so a server error surfaces instead of failing silently. */
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, true);
  }
};

/* ---------------- live readout ---------------- */

const fmtLocal = (ms, tz) =>
  new Intl.DateTimeFormat('en-AU', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
  })
    .format(new Date(ms))
    .replace(/\b(am|pm)\b/, (m) => m.toUpperCase());

function tick() {
  requestAnimationFrame(tick);
  if (!live) return;

  const cfg = live.config;
  const st = ringAt(cfg, live.transition, now());
  const overdue = st.msToGoLive < 0;
  const delayed = Math.abs(st.delayMs) >= 60_000;

  $('s-clock').innerHTML = digitize(formatCountdown(st.msToGoLive));
  $('s-clock').className = overdue ? 'alert' : delayed ? 'warn' : '';
  $('s-eyebrow').className = 'eyebrow ' + (overdue ? 'alert' : delayed ? 'warn' : '');
  $('s-eyebrow').textContent = overdue
    ? 'Running late'
    : st.holding
      ? 'Circle holding'
      : st.phase === 'pre'
        ? 'Not started'
        : 'Until live';

  const delayNote = delayed
    ? `<span class="sep">·</span>${st.delayMs > 0 ? '+' : '−'}${Math.abs(Math.round(st.delayMs / 60_000))} min`
    : '';
  $('s-sub').innerHTML =
    `<span class="scale">${formatRadius(st.radiusM)}</span><span class="sep">·</span>` +
    `${fmtLocal(cfg.goLiveMs, cfg.target.tz)}${delayNote}`;

  $('bar').firstElementChild.style.width = `${(st.t * 100).toFixed(2)}%`;
}

/* ---------------- form population ---------------- */

let dirty = false; // don't clobber fields the operator is mid-edit

function fillForm(cfg) {
  if (dirty) return;

  const wall = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: cfg.target.tz,
  }).formatToParts(new Date(cfg.goLiveMs));
  const part = (t) => wall.find((p) => p.type === t).value;
  $('date').value = `${part('year')}-${part('month')}-${part('day')}`;
  $('time').value = `${part('hour')}:${part('minute')}`;

  $('tz-hint').textContent = `Interpreted in ${cfg.target.tz}. Currently ${fmtLocal(cfg.goLiveMs, cfg.target.tz)}.`;
  $('target-now').textContent = `Now targeting ${cfg.target.name} (${cfg.target.lat.toFixed(5)}, ${cfg.target.lon.toFixed(5)}).`;

  $('window').value = cfg.windowMinutes;
  $('startR').value = Math.round(cfg.startRadiusM / 1000);
  $('endR').value = cfg.endRadiusM;
  $('jitter').value = cfg.jitter;
  $('drift').value = cfg.drift;
  syncLabels();
}

function syncLabels() {
  const w = Number($('window').value);
  $('window-val').textContent = w >= 60 ? `${(w / 60).toFixed(w % 60 ? 1 : 0)} h` : `${w} min`;
  $('startR-val').textContent = `${Number($('startR').value).toLocaleString()} km`;
  $('endR-val').textContent = `${$('endR').value} m`;
  $('jitter-val').textContent = `${Math.round($('jitter').value * 100)}%`;
  $('drift-val').textContent = `${Math.round($('drift').value * 100)}%`;
}

/* ---------------- actions ---------------- */

for (const b of document.querySelectorAll('.delay-btn')) {
  b.onclick = guard(async () => {
    await post('/api/delay', { minutes: Number(b.dataset.min) });
    toast(`Pushed back ${b.dataset.min} minutes`);
  });
}

$('custom-go').onclick = guard(async () => {
  const m = Number($('custom-min').value);
  if (!Number.isFinite(m) || m === 0) return toast('Enter a number of minutes', true);
  await post('/api/delay', { minutes: m });
  $('custom-min').value = '';
  toast(m > 0 ? `Pushed back ${m} minutes` : `Brought forward ${-m} minutes`);
});

$('pull-5').onclick = guard(async () => {
  await post('/api/delay', { minutes: -5 });
  toast('Brought forward 5 minutes');
});

$('reset-time').onclick = guard(async () => {
  await post('/api/reset-time');
  toast('Back to the original time');
});

$('set-time').onclick = guard(async () => {
  await post('/api/time', { date: $('date').value, time: $('time').value });
  dirty = false;
  toast('Go-live updated');
});

for (const el of ['date', 'time']) $(el).oninput = () => (dirty = true);

/* ---- location search ---- */

async function search() {
  const q = $('q').value.trim();
  if (!q) return;
  $('results').innerHTML = '<p class="hint">Searching…</p>';
  try {
    const { results } = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}`)).json();
    if (!results?.length) {
      $('results').innerHTML = '<p class="hint">Nothing found.</p>';
      return;
    }
    $('results').innerHTML = '';
    for (const r of results) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="name"></span><span class="full"></span>`;
      b.querySelector('.name').textContent = r.name;
      b.querySelector('.full').textContent = `${r.full} · ${r.tz}`;
      b.onclick = guard(async () => {
        await post('/api/target', { name: r.name, lat: r.lat, lon: r.lon, tz: r.tz });
        $('results').innerHTML = '';
        $('q').value = '';
        toast(`Target set to ${r.name}`);
      });
      $('results').appendChild(b);
    }
  } catch (err) {
    $('results').innerHTML = '';
    toast(err.message, true);
  }
}

$('search-go').onclick = search;
$('q').onkeydown = (e) => {
  if (e.key === 'Enter') search();
};

/* ---- advanced ---- */

for (const id of ['window', 'startR', 'endR', 'jitter', 'drift']) {
  $(id).oninput = syncLabels;
  $(id).onchange = guard(async () => {
    await post('/api/config', {
      patch: {
        windowMinutes: Number($('window').value),
        startRadiusM: Number($('startR').value) * 1000,
        endRadiusM: Number($('endR').value),
        jitter: Number($('jitter').value),
        drift: Number($('drift').value),
      },
    });
    toast('Updated');
  });
}

$('reroll').onclick = guard(async () => {
  await post('/api/config', { patch: { seed: `reroll-${Date.now().toString(36)}` } });
  toast('New closing pattern');
});

$('restart').onclick = guard(async () => {
  // Re-run the whole closure over whatever time is left, keeping go-live where it is.
  // Forcing 'reset' is what permits the circle to expand back out; without it the
  // monotonic clamp would hold it at its current size and nothing visible would happen.
  const remaining = Math.round((live.config.goLiveMs - now()) / 60_000);
  if (remaining < 5) return toast('Too close to go-live to restart', true);
  await post('/api/config', { patch: { windowMinutes: remaining }, forceMode: 'reset' });
  toast(`Restarting the closure over ${remaining} min`);
});

/* ---- OBS urls ---- */

const base = location.origin;
$('u-full').textContent = `${base}/overlay?layout=full`;
$('u-panel').textContent = `${base}/overlay?layout=panel`;
$('u-control').textContent = `${base}/control`;
for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    const text = $(b.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      // Clipboard access is often denied inside an OBS dock; select it instead so the
      // operator can still copy by hand rather than being told nothing.
      const r = document.createRange();
      r.selectNodeContents($(b.dataset.copy));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      toast('Selected — press Ctrl+C');
    }
  };
}

/* ---------------- boot ---------------- */

connect({
  onState: (p) => {
    live = p;
    fillForm(p.config);
  },
  onStatus: (s) => {
    $('conn').className = s;
    $('conn').textContent = s;
  },
});
tick();
