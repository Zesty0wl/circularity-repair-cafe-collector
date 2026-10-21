// Builds dist/assets, the folder Cloudflare serves the public page from.
//
//   public/                          → dist/assets/
//   MapLibre's script, worker, CSS   → dist/assets/vendor/maplibre/
//
// index.html names its files with ?v=__V__. That becomes a hash of the files
// themselves and of the MapLibre version, so a release that changes any of
// them changes the URLs, and nothing cached under the old ones is served
// against new markup. Wrangler runs this before `dev` and `deploy`
// (build.command in wrangler.jsonc).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const maplibreRoot = path.join(root, 'node_modules', 'maplibre-gl');
const out = path.join(root, 'dist', 'assets');

// Only what the page loads. The dev builds and source maps stay behind.
const MAPLIBRE_FILES = ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor', 'maplibre'), { recursive: true });

fs.cpSync(publicDir, out, { recursive: true });
for (const f of MAPLIBRE_FILES) {
  fs.copyFileSync(path.join(maplibreRoot, 'dist', f), path.join(out, 'vendor', 'maplibre', f));
}

const maplibreVersion = JSON.parse(fs.readFileSync(path.join(maplibreRoot, 'package.json'), 'utf8')).version;
const version = createHash('sha256')
  .update(fs.readFileSync(path.join(publicDir, 'styles.css')))
  .update(fs.readFileSync(path.join(publicDir, 'app.js')))
  // MapLibre's worker is versioned by MapLibre itself.
  .update(maplibreVersion)
  .digest('hex')
  .slice(0, 12);

const indexPath = path.join(out, 'index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replaceAll('__V__', version));

console.log(`dist/assets built, version ${version}, MapLibre ${maplibreVersion}`);
