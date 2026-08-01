/**
 * OBS-managed lifetime.
 *
 * When the Lua script in obs/ launches the server, the server's life should be exactly
 * OBS's life — nothing left running once OBS closes. `script_unload` handles the clean
 * case by killing the pid we write here.
 *
 * The heartbeat covers the case that actually matters: if OBS is force-quit or crashes,
 * `script_unload` never runs and the kill never happens. So the Lua script touches a
 * heartbeat file every few seconds, and if that goes stale we shut ourselves down. Without
 * it a crash would silently orphan a background process, which is the one thing this whole
 * design exists to avoid.
 *
 * Both files live in the app folder rather than a temp directory, because that is the one
 * path the Lua script already knows for certain — it is configured with it.
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME_DIR = '.runtime';
const PID_FILE = 'server.pid';
const BEAT_FILE = 'obs.heartbeat';

// Overridable so the watchdog can be exercised in seconds rather than minutes; the
// defaults are what actually ships.
const ms = (name, fallback) => Number(process.env[name]) || fallback;
/** Grace before the watchdog is armed, so a slow OBS start never kills us. */
const GRACE_MS = ms('CIRCLE_GRACE_MS', 60_000);
/** How stale the heartbeat may get before we conclude OBS is gone. */
const STALE_MS = ms('CIRCLE_STALE_MS', 90_000);
const CHECK_MS = ms('CIRCLE_CHECK_MS', 15_000);

export function runtimePaths(root) {
  const dir = join(root, RUNTIME_DIR);
  return { dir, pid: join(dir, PID_FILE), beat: join(dir, BEAT_FILE) };
}

/**
 * Arms OBS-managed mode. Returns a cleanup function.
 * @param root  app folder
 * @param stop  called to shut the server down
 */
export function startObsMode(root, stop) {
  const { dir, pid, beat } = runtimePaths(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pid, String(process.pid), 'utf8');

  const startedAt = Date.now();

  const timer = setInterval(() => {
    if (Date.now() - startedAt < GRACE_MS) return;

    let last = 0;
    try {
      last = Number(readFileSync(beat, 'utf8').trim()) || 0;
    } catch {
      last = 0; // file missing entirely counts as stale
    }

    if (Date.now() - last > STALE_MS) {
      console.log('');
      console.log('  OBS is no longer running — The Circle is shutting down.');
      stop();
    }
  }, CHECK_MS);
  timer.unref();

  const cleanup = () => {
    clearInterval(timer);
    try {
      rmSync(pid, { force: true });
    } catch { /* best effort */ }
  };

  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  return cleanup;
}
