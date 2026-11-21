import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { APP_NAME } from '../js/config.js';
import { crc32 } from '../js/zip.js';

const root = new URL('../', import.meta.url);
const file = name => fileURLToPath(new URL(name, root));
const json = async name => JSON.parse(await readFile(file(name), 'utf8'));
const write = (name, value) => writeFile(file(name), value);
const supportedFiles = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'];
const resourceFolders = ['cmaps', 'iccs', 'standard_fonts', 'wasm'];

async function copyPdf(expected) {
  const source = 'node_modules/pdfjs-dist/';
  const target = 'vendor/pdfjs/';
  const info = await json(source + 'package.json').catch(() => null);
  if (info?.version !== expected) throw new Error(`pdfjs-dist ${expected} を先に入れてください。`);
  await mkdir(file(target + 'build'), { recursive: true });
  for (const path of [...supportedFiles, ...resourceFolders]) {
    await cp(file(source + path), file(target + path), { recursive: true });
  }
}

async function copyFsrs(expected) {
  const source = 'node_modules/ts-fsrs/';
  const target = 'vendor/ts-fsrs/';
  const info = await json(source + 'package.json').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info) {
    if (info.version !== expected) throw new Error(`ts-fsrs ${expected} を先に入れてください。`);
    await mkdir(file(target), { recursive: true });
    await cp(file(source + 'dist/index.mjs'), file(target + 'index.mjs'));
    await cp(file(source + 'LICENSE'), file(target + 'LICENSE'));
  } else {
    await access(file(target + 'index.mjs'));
    await access(file(target + 'LICENSE'));
  }
}

function chunk(name, data) {
  const payload = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function roundedRect(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, 0, x - right + radius);
  const dy = Math.max(top + radius - y, 0, y - bottom + radius);
  return dx * dx + dy * dy <= radius * radius;
}

function iconColor(x, y) {
  if (roundedRect(x, y, 22, 22, 79, 79, 12)) return [255, 255, 255];
  if (roundedRect(x, y, 17, 17, 73, 73, 11)) return [182, 210, 252];
  return [47, 107, 219];
}

function markColor(x, y) {
  if (x >= 65 && x <= 73 && y >= 25 && y <= 45 - Math.min(x - 65, 73 - x)) return [242, 169, 59];
  if ((x - 40) ** 2 + (y - 44) ** 2 < 19) return [242, 169, 59];
  if (x >= 32 && x <= 69 && y <= 69 && y >= Math.min(50 + Math.abs(x - 54), 57 + Math.abs(x - 39))) {
    return [36, 87, 184];
  }
  return iconColor(x, y);
}

function icon(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + size * 3;
  const pixels = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const samples = [0.25, 0.75].flatMap(dy => [0.25, 0.75].map(dx =>
        markColor((x + dx) * 100 / size, (y + dy) * 100 / size)));
      for (let channel = 0; channel < 3; channel++) {
        pixels[y * stride + 1 + x * 3 + channel] =
          Math.round(samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ]);
}

async function filesIn(folder) {
  const entries = await readdir(file(folder), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await filesIn(path));
    if (entry.isFile()) paths.push(path);
  }
  return paths;
}

const dependencies = (await json('package.json')).devDependencies;
if (process.argv.includes('--with-pdf')) await copyPdf(dependencies['pdfjs-dist']);
await copyFsrs(dependencies['ts-fsrs']);

await mkdir(file('icons'), { recursive: true });
await mkdir(file('vendor'), { recursive: true });
const icons = [192, 512].map(size => ({
  src: `icons/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png',
  purpose: size === 512 ? 'any maskable' : 'any'
}));
for (const [index, size] of [192, 512].entries()) await write(icons[index].src, icon(size));
await write('manifest.webmanifest', JSON.stringify({
  id: './', name: APP_NAME, short_name: APP_NAME,
  lang: 'ja', start_url: './', scope: './', display: 'standalone',
  background_color: '#FFFFFF', theme_color: '#FFFFFF', icons
}, null, 2) + '\n');

const assets = [
  'index.html', 'manifest.webmanifest', ...await filesIn('css'), ...await filesIn('js'),
  ...icons.map(item => item.src), ...await filesIn('vendor')
].sort();
const digest = createHash('sha256');
for (const path of ['sw.js', ...assets]) digest.update(path).update(await readFile(file(path)));
await write('asset-list.js',
  '// tools/assets.mjs で生成します。\n' +
  `self.APP_ASSETS = ${JSON.stringify(assets, null, 2)};\n` +
  `self.APP_CACHE_VERSION = '${digest.digest('hex').slice(0, 16)}';\n`);
