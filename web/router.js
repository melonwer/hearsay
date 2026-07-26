/**
 * Hand-rolled router — method+path table, body parsing, guards, static files (§10.1).
 *
 * No framework, no dependencies. Patterns are exact paths, optionally with `:param`
 * segments (`/api/prompts/:id`). Mutating methods carry a same-origin check; static
 * files are served with a path-traversal guard; HTML responses carry security headers.
 */

import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

/**
 * @typedef {Object} Ctx
 * @property {Req} req
 * @property {Res} res
 * @property {URL} url
 * @property {Record<string, string>} params
 * @property {unknown} body parsed JSON body ({} when there was none)
 * @property {boolean} wantsJson the client prefers JSON (Accept header or /api/ path)
 */

/** @typedef {(ctx: Ctx) => (void|Promise<void>)} Handler */

/** Maximum accepted request body (§10.1). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Content-Security-Policy applied to every HTML response (§10.1). */
export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:";

/** @type {Record<string, string>} */
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Send a JSON response.
 * @param {Res} res
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
export function sendJson(res, status, data, headers = {}) {
  const payload = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * Send an HTML response with the security headers from §10.1.
 * @param {Res} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

/**
 * Send a plain-text response.
 * @param {Res} res
 * @param {number} status
 * @param {string} body
 * @returns {void}
 */
export function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Error response, shaped by what the client asked for.
 * @param {Ctx|{res: Res, wantsJson: boolean}} ctx
 * @param {number} status
 * @param {string} message safe, secret-free text
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
export function sendError(ctx, status, message, headers = {}) {
  if (ctx.wantsJson) {
    sendJson(ctx.res, status, { error: message }, headers);
    return;
  }
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${status}</title>
<link rel="stylesheet" href="/public/style.css"></head>
<body><main class="main"><section class="card"><h1>${status}</h1><p>${message}</p>
<p><a href="/">Back to dashboard</a></p></section></main></body></html>`;
  sendHtml(ctx.res, status, body, headers);
}

/**
 * @param {string} pattern
 * @returns {string[]}
 */
function segments(pattern) {
  return pattern.split('/').filter((s) => s !== '');
}

/**
 * @param {string[]} patternSegs
 * @param {string[]} pathSegs
 * @returns {Record<string, string>|null}
 */
function matchSegments(patternSegs, pathSegs) {
  if (patternSegs.length !== pathSegs.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < patternSegs.length; i += 1) {
    const p = patternSegs[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(pathSegs[i]);
    } else if (p !== pathSegs[i]) {
      return null;
    }
  }
  return params;
}

/**
 * @param {Req} req
 * @param {URL} url
 * @returns {boolean}
 */
function prefersJson(req, url) {
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return true;
  const accept = String(req.headers.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

/**
 * Read and JSON-parse the request body, enforcing the size cap and content type.
 * @param {Req} req
 * @returns {Promise<{ok: true, body: unknown}|{ok: false, status: number, message: string}>}
 */
async function readBody(req) {
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
  if (!hasBody) return { ok: true, body: {} };

  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    return { ok: false, status: 415, message: 'Content-Type must be application/json' };
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = /** @type {Buffer} */ (chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      return { ok: false, status: 413, message: 'Request body too large' };
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
}

/**
 * Same-origin guard for mutating methods (§10.1). CSRF mitigation without tokens:
 * a cross-site form POST carries an Origin header that will not match Host.
 * @param {Req} req
 * @returns {boolean} true when the request may proceed
 */
export function sameOrigin(req) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true; // header absent — nothing to compare
  try {
    return new URL(origin).host === String(req.headers.host ?? '');
  } catch {
    return false;
  }
}

/**
 * Resolve a `/public/...` request to a file path inside `publicDir`, or null when the
 * path escapes it (traversal guard).
 * @param {string} publicDir absolute
 * @param {string} pathname
 * @returns {string|null}
 */
export function resolveStatic(publicDir, pathname) {
  const prefix = '/public/';
  if (!pathname.startsWith(prefix)) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (rel === '' || rel.includes('\0')) return null;
  const root = resolve(publicDir);
  const filePath = resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/**
 * @param {Object} opts
 * @param {string} opts.publicDir absolute path served at /public/*
 */
export function createRouter({ publicDir }) {
  /** @type {{method: string, pattern: string, segs: string[], handler: Handler}[]} */
  const routes = [];

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {Handler} handler
   * @returns {void}
   */
  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), pattern, segs: segments(pattern), handler });
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const wantsJson = prefersJson(req, url);
    /** @type {{res: Res, wantsJson: boolean}} */
    const errCtx = { res, wantsJson };

    try {
      if (!sameOrigin(req)) {
        sendError(errCtx, 403, 'Cross-origin request refused');
        return;
      }

      const staticPath = resolveStatic(publicDir, url.pathname);
      if (url.pathname.startsWith('/public/')) {
        if (staticPath === null) {
          sendError(errCtx, 403, 'Forbidden');
          return;
        }
        if (method !== 'GET') {
          sendError(errCtx, 405, 'Method not allowed', { Allow: 'GET' });
          return;
        }
        try {
          const file = await readFile(staticPath);
          res.writeHead(200, {
            'Content-Type': MIME[extname(staticPath).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': file.length,
            'Cache-Control': 'max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(file);
        } catch {
          sendError(errCtx, 404, 'Not found');
        }
        return;
      }

      const pathSegs = segments(url.pathname);
      /** @type {Set<string>} */
      const allowed = new Set();
      for (const route of routes) {
        const params = matchSegments(route.segs, pathSegs);
        if (params === null) continue;
        allowed.add(route.method);
        if (route.method !== method) continue;

        const parsed = await readBody(req);
        if (!parsed.ok) {
          sendError(errCtx, parsed.status, parsed.message);
          return;
        }
        await route.handler({ req, res, url, params, body: parsed.body, wantsJson });
        return;
      }

      if (allowed.size > 0) {
        sendError(errCtx, 405, 'Method not allowed', { Allow: [...allowed].sort().join(', ') });
        return;
      }
      sendError(errCtx, 404, 'Not found');
    } catch (err) {
      // Never surface internals (or anything key-shaped) to the client.
      process.stderr.write(`[hearsay] ${method} ${url.pathname} failed: ${describe(err)}\n`);
      if (!res.headersSent) sendError(errCtx, 500, 'Internal error');
      else res.end();
    }
  }

  return { add, handle, routes };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
