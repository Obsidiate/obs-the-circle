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
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
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

/**
 * Zip the staged folder with a small, dependency-free writer.
 *
 * We deliberately don't shell out to `zip` (absent on stock Windows) or PowerShell's
 * Compress-Archive (Windows PowerShell writes backslash separators, which violates the ZIP
 * spec and mangles paths when a mac/Linux viewer unzips this cross-platform release). This
 * writes spec-correct forward-slash entries with deflate + CRC-32, identically everywhere.
 * The archive keeps `NAME/` as its top-level folder.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function walk(dir, base, out) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = `${base}/${entry}`; // always forward slash, per the ZIP spec
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else out.push({ rel, full });
  }
}

function zipDir(cwd, name) {
  const files = [];
  walk(join(cwd, name), name, files);

  const d = new Date();
  const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dosDate = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);

  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = readFileSync(f.full);
    const crc = crc32(data);
    let method = 8;
    let body = deflateRawSync(data, { level: 9 });
    if (body.length >= data.length) { method = 0; body = data; } // store if deflate doesn't help
    const nameBuf = Buffer.from(f.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  writeFileSync(join(cwd, `${name}.zip`), Buffer.concat([...parts, centralBuf, eocd]));
}

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

zipDir(OUT, NAME);
rmSync(STAGE, { recursive: true, force: true });

const zip = join(OUT, `${NAME}.zip`);
const size = (readFileSync(zip).length / 1024 / 1024).toFixed(1);
console.log(`wrote ${zip} (${size} MB)`);
