/**
 * Client-script tests for public/app.js — the setup wizard's "Save selected prompts"
 * step. Zero dependencies: a minimal DOM stub is installed on globalThis before the
 * module is imported, and the captured click handler is invoked directly.
 *
 * The regression under test: createPrompt answers 409 for duplicate text and 422 for
 * text over 300 chars — routine outcomes on this page — and the old handler dropped
 * those failures on the floor and redirected to step 3 as if everything saved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * DOM stub — just enough surface for public/app.js to load and for the
 * suggest-save handler to run.
 * ------------------------------------------------------------------ */

class StubElement {
  constructor() {
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {Record<string, Function>} */
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    /** @type {StubElement|null} */
    this.parentSection = null;
  }

  /** @param {string} k @param {string} v */
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }

  /** @param {string} k */
  getAttribute(k) {
    const v = this.attrs.get(k);
    return v === undefined ? null : v;
  }

  /** @param {string} k */
  removeAttribute(k) {
    this.attrs.delete(k);
  }

  /** @param {string} k */
  hasAttribute(k) {
    return this.attrs.has(k);
  }

  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }

  querySelector() {
    return null;
  }

  /** @returns {StubElement[]} */
  querySelectorAll() {
    return [];
  }

  /** @param {string} selector */
  closest(selector) {
    return selector === 'section' ? this.parentSection : null;
  }

  append() {}
}

class StubInput extends StubElement {
  constructor() {
    super();
    this.value = '';
    this.checked = false;
    this.type = 'text';
  }
}

/**
 * Install browser globals. Returns the mutable handles the test drives.
 * @param {(url: string, init: {method?: string, body?: string}) => {ok: boolean, status: number, body: unknown}} route
 */
function installDom(route) {
  /** @type {{url: string, method: string, body: unknown}[]} */
  const requests = [];
  /** @type {Map<string, StubElement|null>} */
  const byId = new Map();

  const g = /** @type {*} */ (globalThis);
  g.HTMLElement = StubElement;
  g.HTMLInputElement = StubInput;
  g.HTMLFormElement = class extends StubElement {};
  g.HTMLSelectElement = class extends StubElement {};
  g.HTMLTextAreaElement = class extends StubElement {};
  g.SVGElement = class extends StubElement {};
  g.SVGSVGElement = class extends StubElement {};
  g.KeyboardEvent = class {};
  g.localStorage = { getItem: () => null, setItem: () => {} };
  g.document = {
    documentElement: new StubElement(),
    body: new StubElement(),
    addEventListener: () => {},
    querySelectorAll: () => [],
    /** @param {string} id */
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (/** @type {string} */ tag) => (tag === 'input' ? new StubInput() : new StubElement()),
  };
  g.window = {
    location: { href: '/setup?step=2', reload: () => {} },
    alert: () => {},
    confirm: () => true,
    scrollX: 0,
    scrollY: 0,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  g.fetch = async (/** @type {string} */ url, /** @type {*} */ init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, method, body });
    const res = route(url, init) ?? { ok: false, status: 404, body: { error: { code: 'not_found', message: 'stub' } } };
    return { ok: res.ok, status: res.status, json: async () => res.body };
  };

  return { requests, byId, window: g.window };
}

/** One suggest-list row. @param {{checked: boolean, value: string, category?: string}} spec */
function makeItem(spec) {
  const check = new StubInput();
  check.checked = spec.checked;
  const text = new StubInput();
  text.value = spec.value;
  const category = new StubInput();
  category.value = spec.category ?? 'general';
  const item = new StubElement();
  item.querySelector = (/** @type {string} */ sel) => {
    if (sel === '[data-suggest-check]') return check;
    if (sel === '[data-suggest-text]') return text;
    if (sel === '[data-suggest-category]') return category;
    return null;
  };
  return { item, check, text, category };
}

test('setup wizard save: failed prompt saves are surfaced, not silently dropped', async () => {
  /** @type {Map<string, {ok: boolean, status: number, body: unknown}>} */
  const promptRoutes = new Map();
  const { requests, byId, window } = installDom((url, init) => {
    if (url === '/api/prompts' && init.method === 'POST') {
      const { text } = JSON.parse(String(init.body));
      return (
        promptRoutes.get(text) ?? { ok: false, status: 422, body: { error: { code: 'unprocessable', message: 'no stub for this text' } } }
      );
    }
    return { ok: false, status: 404, body: { error: { code: 'no_runs', message: 'No panel runs yet' } } };
  });

  const good = makeItem({ checked: true, value: 'best meeting notes tool?' });
  const bad = makeItem({ checked: true, value: 'x'.repeat(320) });
  const unchecked = makeItem({ checked: false, value: 'never sent' });
  promptRoutes.set('best meeting notes tool?', { ok: true, status: 201, body: { id: 1 } });
  promptRoutes.set('x'.repeat(320), {
    ok: false,
    status: 422,
    body: { error: { code: 'unprocessable', message: 'text must be 300 characters or fewer' } },
  });

  const list = new StubElement();
  list.querySelectorAll = () => [good.item, bad.item, unchecked.item];
  const save = new StubElement();
  const section = new StubElement();
  const formError = new StubElement();
  formError.hidden = true;
  section.querySelector = (/** @type {string} */ sel) => (sel === '[data-form-error]' ? formError : null);
  save.parentSection = section;

  byId.set('suggest-list', list);
  byId.set('suggest-save', save);
  byId.set('suggest-form', null);

  await import('../public/app.js');
  const click = save.listeners.click;
  assert.equal(typeof click, 'function', 'save handler registered');

  await click();

  const posts = requests.filter((r) => r.url === '/api/prompts');
  assert.equal(posts.length, 2, 'checked rows posted, unchecked skipped');

  // The 422 must NOT be swallowed: no redirect, the server's message on screen,
  // and the button usable again for a retry.
  assert.notEqual(window.location.href, '/setup?step=3', 'must not advance while saves failed');
  assert.equal(formError.hidden, false);
  assert.match(formError.textContent, /300 characters/);
  assert.equal(save.hasAttribute('disabled'), false, 'save must be re-enabled for a retry');

  // The row that DID save is unchecked so a retry cannot re-post it into a 409.
  assert.equal(good.check.checked, false);

  // Fix the failing prompt and retry: only the failed row is re-sent, then advance.
  bad.text.value = 'shorter prompt';
  promptRoutes.set('shorter prompt', { ok: true, status: 201, body: { id: 2 } });
  await click();
  const retryPosts = requests.filter((r) => r.url === '/api/prompts').slice(2);
  assert.equal(retryPosts.length, 1, 'already-saved prompts are not re-posted');
  assert.equal(/** @type {*} */ (retryPosts[0].body).text, 'shorter prompt');
  assert.equal(window.location.href, '/setup?step=3', 'all saved → advance to step 3');
});
