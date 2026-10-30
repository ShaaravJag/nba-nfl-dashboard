// Local stand-in for Vercel: serves public/ and runs the api/ handlers.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT) || 4321;

// Secrets Vercel keeps in its environment variables (the fantasy key, the ESPN
// login) come from a gitignored .env.local here: KEY=value per line.
try {
  const env = await readFile(fileURLToPath(new URL('../.env.local', import.meta.url)), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env.local: the fantasy view says it isn't set up */ }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const handlers = {
  '/api/live': (await import('../api/live.js')).default,
  '/api/slate': (await import('../api/slate.js')).default,
  '/api/scores': (await import('../api/scores.js')).default,
  '/api/box': (await import('../api/box.js')).default,
  '/api/fantasy': (await import('../api/fantasy.js')).default,
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = handlers[url.pathname];

  if (handler) {
    const shim = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(code) { this._code = code; return this; },
      json(body) { res.writeHead(this._code || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    };
    try { await handler(req, shim); }
    catch (err) { res.writeHead(500); res.end(String(err)); }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1);
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    const html = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    res.end(html);
  }
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
