import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = 8080;
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const entryFiles = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'asset-list.js']);
const directories = new Set(['css', 'js', 'icons', 'vendor']);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/x-font-type1'
};

function message(response, code, text) {
  response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

async function findAsset(url) {
  const path = decodeURIComponent(new URL(url, 'http://localhost').pathname).slice(1) || 'index.html';
  const parts = path.split('/');
  if (/[\\:\0]/.test(path) || parts.some(part => !part || part.startsWith('.')) ||
      !(entryFiles.has(path) || directories.has(parts[0]))) return null;
  const asset = await realpath(resolve(root, path));
  const location = relative(root, asset);
  if (!location || location.startsWith('..') || isAbsolute(location)) return null;
  return asset;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    message(response, 405, 'この方法では開けません。');
    return;
  }
  try {
    const asset = await findAsset(request.url);
    const info = asset && await stat(asset);
    if (!info?.isFile()) {
      message(response, 404, 'ファイルが見つかりません。');
      return;
    }
    response.writeHead(200, {
      'Content-Type': types[extname(asset)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(asset).on('error', () => response.destroy()).pipe(response);
  } catch {
    message(response, 404, 'ファイルが見つかりません。');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'ポート8080はすでに使われています。' :
    '試し用のサーバーを開けませんでした。');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/ を開いてください。`));
