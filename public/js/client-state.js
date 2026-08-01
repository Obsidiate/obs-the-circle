/**
 * Shared client plumbing: live state over SSE, plus the clock every renderer reads.
 *
 * The clock is deliberately the only source of "now" in the client. It applies a
 * server-time offset (so a phone with a skewed clock still agrees with the streaming
 * machine) and implements the time-travel params that make a six-hour sequence testable
 * in seconds.
 */

const params = new URLSearchParams(location.search);

/**
 * ?at=<iso>    start the clock at this instant instead of now
 * ?speed=<n>   run n times faster than real time
 *
 * e.g. /overlay?at=2026-08-02T15:30:00Z&speed=600 runs the whole window in ~36s.
 */
const AT = params.get('at') ? Date.parse(params.get('at')) : null;
const SPEED = Number(params.get('speed') || 1) || 1;
export const SIMULATED = AT !== null || SPEED !== 1;

let serverOffset = 0;
const realStart = performance.now();
const virtualStart = AT;

/** The one clock. Never call Date.now() directly in a renderer. */
export function now() {
  const elapsed = performance.now() - realStart;
  if (virtualStart !== null) return virtualStart + elapsed * SPEED;
  if (SPEED !== 1) return Date.now() + serverOffset + elapsed * (SPEED - 1);
  return Date.now() + serverOffset;
}

export const layout = params.get('layout') === 'panel' ? 'panel' : 'full';

/**
 * Subscribe to server state. Calls back with {config, transition} on connect and on every
 * change. Also reports connection status — surfaced in the control panel only, never
 * drawn on the overlay, since an error toast on a live stream helps nobody.
 */
export function connect({ onState, onStatus } = {}) {
  let current = null;

  const apply = (payload) => {
    serverOffset = payload.serverNow - Date.now();
    current = payload;
    onState?.(payload);
  };

  // Fetch once so we render immediately rather than waiting for the first SSE frame.
  fetch('/api/state')
    .then((r) => r.json())
    .then(apply)
    .catch(() => onStatus?.('offline'));

  const open = () => {
    const es = new EventSource('/api/events');
    es.onopen = () => onStatus?.('live');
    es.onmessage = (e) => {
      try {
        apply(JSON.parse(e.data));
      } catch { /* ignore a malformed frame rather than tearing down the stream */ }
    };
    es.onerror = () => onStatus?.('reconnecting'); // EventSource retries on its own
    return es;
  };
  open();

  return { get: () => current };
}

/** POST helper. Returns the parsed body, throws with the server's message on failure. */
export async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

/** Renders a time string into fixed-width cells so big digits never jitter. */
export function digitize(str) {
  return [...str]
    .map((c) => {
      if (c >= '0' && c <= '9') return `<span class="digit">${c}</span>`;
      if (c === ':') return '<span class="colon">:</span>';
      if (c === '−' || c === '-') return '<span class="sign">−</span>';
      return c;
    })
    .join('');
}
