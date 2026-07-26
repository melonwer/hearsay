/**
 * Page shell — nav, theme, and the `esc()` / `html` helpers (§10.1, §11.2).
 *
 * Every value interpolated into an `html` template is escaped unless it is itself
 * an `html` result (or explicitly wrapped in `raw()`), so page code cannot leak
 * unescaped model output into the document by accident.
 */

/** Marker for a string that is already valid, escaped HTML. */
export class RawHtml {
  /** @param {string} value */
  constructor(value) {
    /** @type {string} */
    this.value = value;
  }

  /** @returns {string} */
  toString() {
    return this.value;
  }
}

/**
 * Wrap a string that is known to be safe HTML. Use sparingly.
 * @param {string} value
 * @returns {RawHtml}
 */
export function raw(value) {
  return new RawHtml(value);
}

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderValue(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return esc(value);
}

/**
 * Auto-escaping HTML tagged template.
 * @param {ReadonlyArray<string>} strings
 * @param {...unknown} values
 * @returns {RawHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new RawHtml(out);
}

/**
 * @typedef {Object} ShellCtx
 * @property {boolean} demo demo mode is on — the banner and disabled run button
 * @property {number} openAlerts unacknowledged alert count for the nav badge
 * @property {string|null} lastRunLine one-line last-run status, or null when there are no runs
 * @property {string} version app version, rendered in the sidebar footer
 */

/** @type {{href: string, label: string}[]} */
const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/answers', label: 'Answers' },
  { href: '/prompts', label: 'Prompts' },
  { href: '/entities', label: 'Entities' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/settings', label: 'Settings' },
  { href: '/methodology', label: 'Methodology' },
];

/** 16px ear / soundwave wordmark glyph. */
const MARK = raw(`<svg class="mark" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Hearsay">
  <title>Hearsay</title>
  <path d="M4.5 6a3.5 3.5 0 1 1 7 0c0 1.6-1 2.3-1.7 2.9-.6.5-1 .9-1 1.8v.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="8.8" cy="13.2" r="1" fill="currentColor"/>
</svg>`);

/**
 * Render a full HTML document.
 *
 * @param {Object} opts
 * @param {string} opts.title page title, without the app suffix
 * @param {string} opts.active nav href of the current page
 * @param {RawHtml} opts.body
 * @param {ShellCtx} opts.ctx
 * @returns {string}
 */
export function layout({ title, active, body, ctx }) {
  const nav = NAV.map((item) => {
    const isActive = item.href === active;
    const badge =
      item.href === '/alerts' && ctx.openAlerts > 0
        ? html`<span class="badge" title="${ctx.openAlerts} open">${ctx.openAlerts}</span>`
        : '';
    return html`<a class="nav-item${isActive ? ' is-active' : ''}" href="${item.href}"${isActive
      ? raw(' aria-current="page"')
      : ''}>${item.label}${badge}</a>`;
  });

  const banner = ctx.demo
    ? html`<div class="demo-banner" role="status">
        <span class="demo-banner-icon" aria-hidden="true">◆</span>
        <span
          >Demo data — fictional brands. Add an API key and set <code>HEARSAY_DEMO=0</code> for real numbers.
          <a href="/settings">Settings</a></span
        >
      </div>`
    : '';

  const doc = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Hearsay</title>
    <link rel="stylesheet" href="/public/style.css" />
  </head>
  <body>
    ${banner}
    <div class="app">
      <aside class="sidebar">
        <a class="wordmark" href="/">${MARK}<span>Hearsay</span></a>
        <nav class="nav" aria-label="Sections">${nav}</nav>
        <div class="sidebar-foot">
          <p class="last-run" id="last-run">${ctx.lastRunLine ?? 'No panel runs yet.'}</p>
          <div class="run-progress" id="run-progress" hidden>
            <div class="run-progress-bar" id="run-progress-bar"></div>
          </div>
          <button
            type="button"
            class="btn btn-run"
            id="run-panel"
            ${ctx.demo ? raw('disabled title="Disabled in demo mode"') : ''}
          >
            Run panel now
          </button>
          <p class="version">v${ctx.version}</p>
        </div>
      </aside>
      <main class="main">
        <header class="page-head">
          <h1>${title}</h1>
          <div class="theme-toggle" role="group" aria-label="Theme">
            <button type="button" data-theme-set="auto" aria-pressed="true">Auto</button>
            <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
            <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
          </div>
        </header>
        ${body}
      </main>
    </div>
    <script src="/public/app.js" type="module"></script>
  </body>
</html>
`;
  return doc.value;
}

/**
 * Friendly empty state: two lines and an optional action (§11.3).
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.line what is missing and why the panel is blank
 * @param {string} [opts.hint] the next step, in plain language
 * @param {{href: string, label: string}} [opts.action]
 * @returns {RawHtml}
 */
export function emptyState({ title, line, hint, action }) {
  return html`<section class="card empty-state">
    <h2>${title}</h2>
    <p>${line}</p>
    ${hint ? html`<p class="muted">${hint}</p>` : ''}
    ${action ? html`<p><a class="btn" href="${action.href}">${action.label}</a></p>` : ''}
  </section>`;
}
