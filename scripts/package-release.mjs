/**
 * Builds the downloadable release zip.
 *
 * The zip includes node_modules so there is no `npm install` step for someone who just
 * wants an overlay — unzip, double-click, done. That is only tolerable because the runtime
 * tree is two dependency-free packages (luxon, tz-lookup); maplibre is a devDependency,
 * since its dist is already vendored into public/vendor.
 *
 * Run: npm run package
 */
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = `obs-the-circle-v${pkg.version}`;
const OUT = join(ROOT, 'release');
const STAGE = join(OUT, NAME);

// Everything the overlay needs at runtime. Deliberately explicit rather than a
// blocklist, so a stray state.json or cache/ can never end up in a public download.
const INCLUDE = [
  'server',
  'public',
  'obs',
  'package.json',
  'start.sh',
  'start.command',
  'start.cmd',
  'LICENSE',
];

const RUNTIME_DEPS = Object.keys(pkg.dependencies || {});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const entry of INCLUDE) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) {
    if (entry === 'LICENSE') continue;
    throw new Error(`missing release input: ${entry}`);
  }
  cpSync(src, join(STAGE, entry), { recursive: true });
}

for (const dep of RUNTIME_DEPS) {
  const src = join(ROOT, 'node_modules', dep);
  if (!existsSync(src)) throw new Error(`run npm install first — missing ${dep}`);
  cpSync(src, join(STAGE, 'node_modules', dep), { recursive: true });
}

// Launchers must stay executable through the zip.
for (const f of ['start.sh', 'start.command']) chmodSync(join(STAGE, f), 0o755);

writeFileSync(join(STAGE, 'START HERE.txt'), `The Circle ${pkg.version}
================================================================

1. Install Node.js if you haven't:  https://nodejs.org  (take the LTS one)

2. Start The Circle:
      Windows   double-click  start.cmd
      macOS     double-click  start.command
      Linux     run           ./start.sh

   A window opens and stays open. Leave it running while you stream.
   The control panel opens in your browser automatically.

3. In OBS, add the overlay:
      Sources  ->  +  ->  Browser
      URL      http://localhost:7333/overlay?layout=full
      Width    1920      Height   1080
      Untick "Shutdown source when not visible"

4. In OBS, add the control panel:
      Docks  ->  Custom Browser Docks...
      Name     Circle
      URL      http://localhost:7333/control
      Apply, then drag the dock wherever you like.

That's it. No plugin, nothing to compile.

Both URLs are also listed in the control panel with copy buttons, and the
window from step 2 prints a LAN address you can open on your phone.

Full documentation: https://github.com/Obsidiate/obs-the-circle
`);

execFileSync('zip', ['-qr', `${NAME}.zip`, NAME], { cwd: OUT });
rmSync(STAGE, { recursive: true, force: true });

const zip = join(OUT, `${NAME}.zip`);
const size = (readFileSync(zip).length / 1024 / 1024).toFixed(1);
console.log(`wrote ${zip} (${size} MB)`);
