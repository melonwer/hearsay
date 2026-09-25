/** Browser-script test for the setup wizard's atomic review and approval path. */
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

  /** @param {string} k @param {boolean} force */
  toggleAttribute(k, force) {
    if (force) this.setAttribute(k, '');
    else this.removeAttribute(k);
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

  replaceChildren() {}
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
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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

test('setup keeps a rejected draft editable and approves all selected questions in one request', async () => {
  let valid = false;
  const { requests, byId, window } = installDom((url, init) => {
    if (url === '/api/setup/drafts' && init.method === 'POST') {
      if (!valid) return { ok: false, status: 422, body: { error: { message: 'Question exceeds 300 characters' } } };
      return { ok: true, status: 201, body: { id: 7, revision: 1 } };
    }
    if (url === '/api/setup/drafts/7/review') return { ok: true, status: 200, body: {
      reviewHash: 'hash-7', selectedQuestionCount: 1, apiCalls: 2,
      subscriptionCalls: 1, totalCalls: 3, validationErrors: [], hasRunRoute: true,
    } };
    if (url === '/api/setup/drafts/7/approve') return { ok: true, status: 200, body: { approved: 1 } };
    return { ok: false, status: 404, body: { error: { message: 'Not found' } } };
  });

  const text = new StubInput();
  text.value = 'Which tools help sales teams summarize calls?';
  const note = new StubInput();
  note.value = 'Sales call 42';
  const check = new StubInput();
  check.checked = true;
  const phrase = new StubElement();
  phrase.querySelector = (/** @type {string} */ selector) => ({
    '[data-suggest-text]': text, '[data-suggest-note]': note, '[data-suggest-check]': check,
  })[selector] ?? null;
  const label = new StubInput();
  label.value = 'Find options';
  const category = new StubInput();
  category.value = 'general';
  const intent = new StubElement();
  intent.querySelector = (/** @type {string} */ selector) => ({
    '[data-suggest-label]': label, '[data-suggest-category]': category,
  })[selector] ?? null;
  intent.querySelectorAll = () => [phrase];
  const list = new StubElement();
  list.querySelectorAll = () => [intent];
  list.setAttribute('data-entities', JSON.stringify([
    { name: 'Notewell', aliases: ['NW'], domains: ['notewell.example'], isSelf: true },
    { name: 'OtherCo', aliases: [], domains: ['other.example'], isSelf: false },
  ]));
  const form = new (/** @type {*} */ (globalThis).HTMLFormElement)();
  const fields = new Map(['audience', 'productJob', 'desiredConversion', 'languagePreference', 'marketContext', 'contextNotes']
    .map((name) => [name, new StubInput()]));
  fields.get('audience').value = 'Sales teams';
  fields.get('productJob').value = 'Summarize calls';
  form.querySelector = (/** @type {string} */ selector) => fields.get(selector.replace(/^\[name="|"\]$/g, '')) ?? null;
  const reviewButton = new StubElement();
  const approveButton = new StubElement();
  const reviewPanel = new StubElement();
  reviewPanel.hidden = true;
  const details = new StubElement();
  const status = new StubElement();
  const section = new StubElement();
  const formError = new StubElement();
  formError.hidden = true;
  section.querySelector = (/** @type {string} */ selector) => selector === '[data-form-error]' ? formError : null;
  reviewButton.parentSection = section;
  approveButton.parentSection = section;

  byId.set('suggest-list', list);
  byId.set('suggest-form', form);
  byId.set('suggest-add-intent', new StubElement());
  byId.set('suggest-review', reviewButton);
  byId.set('suggest-approve', approveButton);
  byId.set('suggest-review-panel', reviewPanel);
  byId.set('suggest-review-details', details);
  byId.set('suggest-status', status);

  await import('../public/app.js');
  await reviewButton.listeners.click();
  assert.match(formError.textContent, /300 characters/);
  assert.equal(formError.hidden, false);
  assert.equal(reviewButton.hasAttribute('disabled'), false);
  assert.equal(reviewPanel.hidden, true);
  assert.equal(requests.some((request) => request.url === '/api/prompts'), false);

  valid = true;
  await reviewButton.listeners.click();
  assert.equal(reviewPanel.hidden, false);
  assert.equal(approveButton.hasAttribute('disabled'), false);
  const draftPosts = requests.filter((request) => request.url === '/api/setup/drafts');
  assert.equal(draftPosts.length, 2);
  const submitted = /** @type {*} */ (draftPosts[1].body);
  assert.equal(submitted.payload.intents.length, 1);
  assert.equal(submitted.payload.intents[0].paraphrases[0].sourceNote, 'Sales call 42');
  assert.equal(submitted.payload.context.audience, 'Sales teams');
  assert.deepEqual(submitted.payload.brand.aliases, ['NW']);
  await approveButton.listeners.click();
  const approval = requests.find((request) => request.url === '/api/setup/drafts/7/approve');
  assert.deepEqual(approval?.body, { revision: 1, review_hash: 'hash-7', approve: true });
  assert.equal(status.hidden, false);
  assert.equal(window.location.href, '/setup?step=2');
});
