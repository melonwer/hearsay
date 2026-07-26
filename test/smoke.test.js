/**
 * Phase 0 gate: the server boots on an ephemeral port with a temp database and serves
 * the app shell. No network, no fixtures, no fabricated data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { isoNow, run } from '../core/db.js';
import { startServer } from '../server.js';

const NAV_LABELS = ['Dashboard', 'Answers', 'Prompts', 'Entities', 'Alerts', 'Settings', 'Methodology'];

test('boots and serves the app shell', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-smoke-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: join(dir, 'hearsay.db'),
    config: buildConfig({}),
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.port}`;

  // Empty database with demo mode off → first-run wizard (§11.8).
  const redirect = await fetch(`${base}/`, { redirect: 'manual' });
  await redirect.text();
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/setup');

  run(app.db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
    'Acme',
    '[]',
    '["acme.example"]',
    1,
    isoNow(),
  ]);

  const res = await fetch(`${base}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(body, /<title>Dashboard · Hearsay<\/title>/);
  assert.match(body, /class="wordmark"/);
  for (const label of NAV_LABELS) {
    assert.match(body, new RegExp(`class="nav-item[^"]*"[^>]*>${label}`), `nav is missing ${label}`);
  }

  // Security headers on HTML (§10.1).
  assert.match(res.headers.get('content-security-policy') ?? '', /^default-src 'self';/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  // Every other shell page renders.
  for (const path of ['/answers', '/prompts', '/entities', '/alerts', '/settings', '/setup', '/methodology']) {
    const page = await fetch(`${base}${path}`);
    const html = await page.text();
    assert.equal(page.status, 200, `${path} did not render`);
    assert.match(html, /class="nav-item/, `${path} is missing the nav`);
  }

  // Static assets are served from /public with a MIME type and cache header.
  const css = await fetch(`${base}/public/style.css`);
  const cssBody = await css.text();
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.match(cssBody, /--s1: #2a78d6;/);

  // Unknown paths 404 rather than falling through to a page.
  const missing = await fetch(`${base}/nope`);
  await missing.text();
  assert.equal(missing.status, 404);
});
