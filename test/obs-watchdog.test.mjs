/**
 * The crash path.
 *
 * script_unload handles a normal OBS close. This covers the case it cannot: OBS force-quit
 * or crashed, so nothing ever kills the server. The heartbeat has to catch that, otherwise
 * a background process outlives OBS — the exact thing the OBS-launcher design exists to
 * prevent.
 *
 * Run: node test/obs-watchdog.test.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, '.runtime');
const BEAT = join(RUNTIME, 'obs.heartbeat');
const PID = join(RUNTIME, 'server.pid');
const PORT = 7556;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const responds = async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
};

rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

// Compressed timings so this runs in seconds; ships as 60s grace / 90s stale.
const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js'), '--obs', '--port', String(PORT)], {
  env: { ...process.env, CIRCLE_GRACE_MS: '3000', CIRCLE_STALE_MS: '3000', CIRCLE_CHECK_MS: '500', NO_OPEN: '1' },
  stdio: 'ignore',
});

console.log('\n== server under a live heartbeat ==');
await sleep(2000);
ok(await responds(), 'server is up');
ok(existsSync(PID), 'pidfile written');
ok(alive(child.pid), 'process running');

// Beat steadily for a few seconds — it must NOT decide OBS is gone while OBS is fine.
const beat = setInterval(() => writeFileSync(BEAT, String(Date.now()), 'utf8'), 500);
await sleep(6000);
ok(alive(child.pid), 'survives well past the stale window while the heartbeat is fresh');
ok(await responds(), 'still serving');

console.log('\n== heartbeat stops (OBS crashed) ==');
clearInterval(beat);
const stoppedAt = Date.now();

let exited = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (!alive(child.pid)) {
    exited = true;
    break;
  }
}
const took = ((Date.now() - stoppedAt) / 1000).toFixed(1);

ok(exited, `server shut itself down after the heartbeat went stale (${took}s)`);
ok(!(await responds()), 'port released');
ok(!existsSync(PID), 'pidfile cleaned up on exit');

if (!exited) child.kill('SIGKILL');
rmSync(RUNTIME, { recursive: true, force: true });

console.log('');
console.log(fails === 0 ? 'ALL WATCHDOG TESTS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
