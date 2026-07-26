/**
 * Router tests (§10.1, §15) — the guards rather than the pages: 404 in the caller's
 * language, 405 with `Allow`, 415 on a non-JSON body, the 1 MB cap, the same-origin
 * refusal on mutating methods, the static path-traversal guard, and `esc()`.
 *
 * Plus a render smoke test for every §10.2 page against `fixtures/ui-fixture.sql`, so a
 * page that stops rendering — or starts rendering model text as markup — fails here and
 * not in a screenshot. The server is the real one, booted on port 0 over a temp file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../core/config.js';
import { run as exec, isoNow } from '../core/db.js';
import { esc, html, raw } from '../web/layout.js';
import { MAX_BODY_BYTES, resolveStatic, sendError } from '../web/router.js';
import { startServer } from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../public');
const FIXTURE_SQL = readFileSync(resolve(HERE, 'fixtures/ui-fixture.sql'), 'utf8');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Boot the real server on an ephemeral port over a throwaway database.
 *
 * @param {import('node:test').TestContext} t
 * @param {{fixture?: boolean, env?: Record<string, string|undefined>}} [opts]
 */
async function newApp(t, { fixture = false, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-router-'));
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: join(dir, 'hearsay.db'),
    config: buildConfig(env),
  });
  if (fixture) app.db.exec(FIXTURE_SQL);
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, base: `http://127.0.0.1:${app.port}`, origin: `http://127.0.0.1:${app.port}` };
}

/* ------------------------------------------------------------------ *
 * Status codes and error envelopes (§10.1, §10.3)
 * ------------------------------------------------------------------ */

test('404 answers in the language the caller asked for (§10.1)', async (t) => {
  const app = await newApp(t);

  const asHtml = await fetch(`${app.base}/nope`, { headers: { Accept: 'text/html' } });
  const htmlBody = await asHtml.text();
  assert.equal(asHtml.status, 404);
  assert.match(asHtml.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(htmlBody.includes('<h1>404</h1>'), 'HTML 404 should render the status');
  // Error pages carry the same security headers as any other HTML (§10.1).
  assert.match(asHtml.headers.get('content-security-policy') ?? '', /^default-src 'self';/);
  assert.equal(asHtml.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(asHtml.headers.get('referrer-policy'), 'no-referrer');

  const asJson = await fetch(`${app.base}/nope`, { headers: { Accept: 'application/json' } });
  const jsonBody = await asJson.json();
  assert.equal(asJson.status, 404);
  assert.match(asJson.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(Object.keys(jsonBody), ['error']);
  assert.equal(jsonBody.error.code, 'not_found');
  assert.equal(typeof jsonBody.error.message, 'string');

  // Under /api the path decides, whatever Accept says — agents get JSON either way.
  const apiPath = await fetch(`${app.base}/api/nope`, { headers: { Accept: 'text/html' } });
  const apiBody = await apiPath.json();
  assert.equal(apiPath.status, 404);
  assert.equal(apiBody.error.code, 'not_found');
});

test('405 names the methods that would have worked (§10.1)', async (t) => {
  const app = await newApp(t);

  const onlyGet = await fetch(`${app.base}/api/summary`, { method: 'DELETE' });
  const onlyGetBody = await onlyGet.json();
  assert.equal(onlyGet.status, 405);
  assert.equal(onlyGet.headers.get('allow'), 'GET');
  assert.equal(onlyGetBody.error.code, 'method_not_allowed');

  // A `:param` route with two methods lists both, sorted, so the header is stable.
  const twoMethods = await fetch(`${app.base}/api/entities/1`, { method: 'POST' });
  await twoMethods.text();
  assert.equal(twoMethods.status, 405);
  assert.equal(twoMethods.headers.get('allow'), 'DELETE, PATCH');

  // Static files are read-only.
  const staticWrite = await fetch(`${app.base}/public/style.css`, { method: 'PUT' });
  await staticWrite.text();
  assert.equal(staticWrite.status, 405);
  assert.equal(staticWrite.headers.get('allow'), 'GET');
});

test('415 on a body that is not JSON (§10.1)', async (t) => {
  const app = await newApp(t);

  const textBody = await fetch(`${app.base}/api/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'name=Notewell',
  });
  const textResult = await textBody.json();
  assert.equal(textBody.status, 415);
  assert.equal(textResult.error.code, 'unsupported_media_type');

  const formBody = await fetch(`${app.base}/api/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=Notewell',
  });
  await formBody.text();
  assert.equal(formBody.status, 415);

  // A charset parameter is fine — only the media type is checked.
  const withCharset = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ includeBrandedInSov: true }),
  });
  const toggled = await withCharset.json();
  assert.equal(withCharset.status, 200);
  assert.equal(toggled.includeBrandedInSov, true);

  // Malformed JSON is a 400, not a 415 — the type was right, the bytes were not.
  const broken = await fetch(`${app.base}/api/entities`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{"name": ',
  });
  const brokenResult = await broken.json();
  assert.equal(broken.status, 400);
  assert.equal(brokenResult.error.code, 'bad_request');
});

test('a body over the 1 MB cap is refused, not buffered (§10.1)', async (t) => {
  const app = await newApp(t);
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);

  const oversized = JSON.stringify({ name: 'Notewell', pad: 'x'.repeat(MAX_BODY_BYTES + 4096) });
  assert.ok(oversized.length > MAX_BODY_BYTES);
  const tooBig = await fetch(`${app.base}/api/entities`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: oversized,
  });
  const tooBigResult = await tooBig.json();
  assert.equal(tooBig.status, 413);
  assert.equal(tooBigResult.error.code, 'payload_too_large');

  // …and a body just under the cap still gets through to the handler.
  const underCap = JSON.stringify({ includeBrandedInSov: true, pad: 'x'.repeat(MAX_BODY_BYTES - 4096) });
  assert.ok(underCap.length < MAX_BODY_BYTES);
  const accepted = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: underCap,
  });
  const acceptedResult = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(acceptedResult.includeBrandedInSov, true);
});

test('mutating methods refuse a cross-site Origin (§10.1)', async (t) => {
  const app = await newApp(t);
  const body = JSON.stringify({ includeBrandedInSov: true });

  const crossSite = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, Origin: 'http://evil.example' },
    body,
  });
  const refused = await crossSite.json();
  assert.equal(crossSite.status, 403);
  assert.equal(refused.error.code, 'forbidden');

  // A different port on the same host is still a different origin.
  const wrongPort = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, Origin: 'http://127.0.0.1:1' },
    body,
  });
  await wrongPort.text();
  assert.equal(wrongPort.status, 403);

  // The app's own forms send a matching Origin and are unaffected.
  const sameSite = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, Origin: app.origin },
    body,
  });
  await sameSite.text();
  assert.equal(sameSite.status, 200);

  // No Origin header at all (curl, an agent, a same-origin form) — nothing to compare.
  const noOrigin = await fetch(`${app.base}/api/settings`, { method: 'PATCH', headers: JSON_HEADERS, body });
  await noOrigin.text();
  assert.equal(noOrigin.status, 200);

  // An opaque origin ("null") is a header that is present and does not match the host —
  // a sandboxed frame or a local file, never this app's own pages. Treat it as cross-site.
  const opaqueOrigin = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, Origin: 'null' },
    body,
  });
  await opaqueOrigin.text();
  assert.equal(opaqueOrigin.status, 403);

  // Safe methods are never blocked by the guard.
  const read = await fetch(`${app.base}/api/entities`, { headers: { Origin: 'http://evil.example' } });
  await read.text();
  assert.equal(read.status, 200);
});

/* ------------------------------------------------------------------ *
 * Static files (§10.1)
 * ------------------------------------------------------------------ */

test('resolveStatic keeps every path inside the public directory (§10.1)', () => {
  const inside = resolveStatic(PUBLIC_DIR, '/public/style.css');
  assert.equal(inside, resolve(PUBLIC_DIR, 'style.css'));
  assert.equal(resolveStatic(PUBLIC_DIR, '/public/nested/../style.css'), resolve(PUBLIC_DIR, 'style.css'));

  for (const escape of [
    '/public/../server.js',
    '/public/nested/../../server.js',
    '/public/%2e%2e%2fserver.js',
    '/public/%2e%2e/%2e%2e/package.json',
    '/public/..%2f..%2fetc%2fpasswd',
    '/public/%00style.css',
    '/public/',
  ]) {
    assert.equal(resolveStatic(PUBLIC_DIR, escape), null, `${escape} should not resolve`);
  }

  // Traversal that stays inside the root is not an escape — it is just a path.
  assert.equal(resolveStatic(PUBLIC_DIR, '/public/a/b/../../style.css'), resolve(PUBLIC_DIR, 'style.css'));

  // Anything outside the /public/ prefix is not this function's business.
  assert.equal(resolveStatic(PUBLIC_DIR, '/style.css'), null);
  assert.equal(resolveStatic(PUBLIC_DIR, '/publicly/style.css'), null);
});

test('static assets are served from /public and traversal is refused (§10.1)', async (t) => {
  const app = await newApp(t);

  const css = await fetch(`${app.base}/public/style.css`);
  const cssBody = await css.text();
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'max-age=3600');
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(cssBody.includes(':root'), 'style.css should carry the design tokens');

  // Percent-encoded separators survive URL parsing, so the guard is what stops these.
  for (const escape of ['/public/%2e%2e%2fserver.js', '/public/..%2f..%2fpackage.json']) {
    const res = await fetch(`${app.base}${escape}`);
    const body = await res.text();
    assert.equal(res.status, 403, `${escape} should be refused`);
    assert.ok(!body.includes('startServer'), 'no source may leak through the static handler');
    assert.ok(!body.includes('"hearsay"'), 'no source may leak through the static handler');
  }

  const missing = await fetch(`${app.base}/public/not-here.css`);
  await missing.text();
  assert.equal(missing.status, 404);
});

/* ------------------------------------------------------------------ *
 * Escaping (§10.1, §19.6)
 * ------------------------------------------------------------------ */

test('esc() escapes exactly the five characters §10.1 names', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  // `&` is replaced first, so an entity in the source is escaped rather than preserved.
  assert.equal(esc('&amp;'), '&amp;amp;');
  assert.equal(esc("O'Hare"), 'O&#39;Hare');
  assert.equal(esc('plain text'), 'plain text');

  // Null and undefined render as nothing, not as the words.
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});

test('the html template escapes interpolations unless they are already HTML (§10.1)', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  assert.equal(
    html`<p>${hostile}</p>`.value,
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
  );
  assert.equal(html`<a title="${`a"b`}"></a>`.value, '<a title="a&quot;b"></a>');

  // A nested html result is inserted as-is — and is not escaped a second time.
  const nested = html`<em>${'a&b'}</em>`;
  assert.equal(html`<p>${nested}</p>`.value, '<p><em>a&amp;b</em></p>');

  // raw() is the only escape hatch, and arrays are rendered element by element.
  assert.equal(html`<p>${raw('<br>')}</p>`.value, '<p><br></p>');
  assert.equal(html`<ul>${[html`<li>1</li>`, html`<li>2</li>`]}</ul>`.value, '<ul><li>1</li><li>2</li></ul>');

  // Nothing renders for the empty values, so a falsy branch leaves no residue.
  assert.equal(html`<p>${null}${undefined}${false}${true}</p>`.value, '<p></p>');
});

test('the HTML error page escapes its message too (§10.1)', () => {
  /** Minimal ServerResponse stand-in: this is a pure formatting function. */
  const capture = () => {
    const sink = { status: 0, headers: /** @type {Record<string, string>} */ ({}), body: '' };
    const res = /** @type {*} */ ({
      /** @param {number} status @param {Record<string, string>} headers */
      writeHead(status, headers) {
        sink.status = status;
        sink.headers = headers;
      },
      /** @param {string} body */
      end(body) {
        sink.body = String(body);
      },
    });
    return { sink, res };
  };

  const wantsHtml = capture();
  sendError({ res: wantsHtml.res, wantsJson: false }, 404, '<script>alert("x")</script>');
  assert.equal(wantsHtml.sink.status, 404);
  assert.ok(!wantsHtml.sink.body.includes('<script>'), 'the message must not become markup');
  assert.ok(wantsHtml.sink.body.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));

  // The JSON envelope carries the message verbatim — JSON.stringify is the escape there.
  const wantsJson = capture();
  sendError({ res: wantsJson.res, wantsJson: true }, 409, 'An entity named <b> already exists', {}, 'conflict');
  assert.equal(wantsJson.sink.status, 409);
  assert.deepEqual(JSON.parse(wantsJson.sink.body), {
    error: { code: 'conflict', message: 'An entity named <b> already exists' },
  });
});

test('entity text reaches the page escaped, never as markup (§10.1)', async (t) => {
  const app = await newApp(t);
  exec(app.db, 'INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, ?, ?)', [
    '<script>alert("x&y")</script>',
    JSON.stringify(["O'Hare"]),
    '[]',
    1,
    isoNow(),
  ]);

  const page = await fetch(`${app.base}/entities`);
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!body.includes('<script>alert'), 'entity name must not reach the document as a tag');
  assert.ok(body.includes('&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'), 'name should render escaped');
  assert.ok(body.includes('O&#39;Hare'), 'aliases should render escaped');
});

/* ------------------------------------------------------------------ *
 * Page render smoke tests (§10.2, §11)
 * ------------------------------------------------------------------ */

/** Every §10.2 page, with a heading that only that page renders. */
const PAGES = [
  ['/', '<h1>Dashboard</h1>', '<h2>Share of AI voice</h2>'],
  ['/answers', '<h1>Answers</h1>', 'class="card filter-row"'],
  ['/prompts', '<h1>Prompts</h1>', '<h2>Add a prompt</h2>'],
  ['/entities', '<h1>Entities</h1>', '<h2>Add an entity</h2>'],
  ['/alerts', '<h1>Alerts</h1>', '<h2>Open alerts</h2>'],
  ['/settings', '<h1>Settings</h1>', '<h2>Providers</h2>'],
  ['/methodology', '<h1>Methodology</h1>', '<h2>Methodology</h2>'],
  ['/setup', '<h1>Setup</h1>', '<h2>1 · Your brand</h2>'],
];

test('every §10.2 page renders against the fixture database', async (t) => {
  const app = await newApp(t, { fixture: true });

  for (const [path, h1, marker] of PAGES) {
    const res = await fetch(`${app.base}${path}`);
    const body = await res.text();
    assert.equal(res.status, 200, `${path} did not render`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/, `${path} is not HTML`);
    assert.ok(body.includes(h1), `${path} is missing ${h1}`);
    assert.ok(body.includes(marker), `${path} is missing ${marker}`);
    assert.ok(body.includes('class="nav"'), `${path} is missing the nav`);
    assert.match(res.headers.get('content-security-policy') ?? '', /^default-src 'self';/, `${path} has no CSP`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} may be sniffed`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${path} leaks a referrer`);
  }
});

test('a cold database redirects to the wizard (§11.8)', async (t) => {
  const app = await newApp(t);

  const redirect = await fetch(`${app.base}/`, { redirect: 'manual' });
  await redirect.text();
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/setup');

  // The wizard itself, and every other page, still renders on an empty database.
  for (const [path] of PAGES.slice(1)) {
    const res = await fetch(`${app.base}${path}`);
    await res.text();
    assert.equal(res.status, 200, `${path} did not render on a cold database`);
  }
});

test('fixture data reaches the answers page, marked up as it was counted (§11.4)', async (t) => {
  const app = await newApp(t, { fixture: true });

  const res = await fetch(`${app.base}/answers`);
  const body = await res.text();
  assert.equal(res.status, 200);

  // The stored answer text, verbatim.
  assert.ok(body.includes('most reviewers land on'), 'the answer text should be on the page');
  // …with the analyser's own spans marked, coloured by entity rather than by rank (§11.1).
  assert.ok(body.includes('<mark class="mk mk-s1" title="Notewell">Notewell</mark>'), 'brand should be marked s1');
  assert.ok(body.includes('<mark class="mk mk-s2" title="Larkspur">Larkspur</mark>'), 'competitor should be marked s2');
  // Citations, the recommendation pill, and the consumer-product provider names.
  assert.ok(body.includes('roundup.example'), 'citation domains should render');
  assert.ok(body.includes('pill-good">recommended'), 'a recommended answer should be badged');
  assert.ok(body.includes('ChatGPT') && body.includes('Perplexity'), 'providers use consumer names');
  // The stored error collapses behind its error-kind chip instead of vanishing.
  assert.ok(body.includes('pill pill-error">timeout'), 'errored calls keep their error-kind chip');
  assert.ok(body.includes('4 answers'), 'the result count should include the errored call');

  // Filtering is server-side: the same page, narrowed by query string.
  const filtered = await fetch(`${app.base}/answers?provider=gemini`);
  const filteredBody = await filtered.text();
  assert.equal(filtered.status, 200);
  assert.ok(filteredBody.includes('1 answers'), 'the provider filter should narrow the result count');
  assert.ok(!filteredBody.includes('most reviewers land on'), 'the ChatGPT answer should be filtered out');
});

test('fixture data reaches the dashboard, prompts and alerts pages', async (t) => {
  const app = await newApp(t, { fixture: true });

  const dashboard = await (await fetch(`${app.base}/`)).text();
  assert.ok(dashboard.includes('Notewell'), 'the brand should appear on the dashboard');
  assert.ok(dashboard.includes('Notewell mention rate fell on ChatGPT'), 'open alerts should surface');
  assert.ok(dashboard.includes('most reviewers land on'), 'latest receipts should quote a real snippet');
  // §19.6 #4: no naked percentages — the KPI rates carry their n.
  assert.ok(dashboard.includes('class="rate-n">n='), 'rates must ship with their sample size');

  const prompts = await (await fetch(`${app.base}/prompts`)).text();
  assert.ok(prompts.includes('Best AI meeting-notes tool for a small sales team'), 'the intent label should render');
  assert.ok(prompts.includes('2 paraphrases'), 'a two-paraphrase intent should not get the single-wording nudge');
  assert.ok(prompts.includes('Which AI note taker do small sales teams actually recommend?'), 'both paraphrases');

  const alerts = await (await fetch(`${app.base}/alerts`)).text();
  assert.ok(alerts.includes('Notewell mention rate fell on ChatGPT'), 'the alert title should render');
  assert.ok(alerts.includes('down from 3 of 3'), 'the alert detail keeps the numbers the rule fired on (§9)');

  // The nav badge counts the open alert.
  assert.ok(alerts.includes('class="badge"'), 'the open alert should show in the nav badge');
});
