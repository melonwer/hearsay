import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { AGENT_ROUTES, AGENT_SURFACES_SQL, isAgentSurface } from '../core/agent-routes.js';
import { get } from '../core/db.js';
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
  { href: '/evidence', label: 'Evidence' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/weekly-review', label: 'Weekly review' },
  { href: '/research', label: 'Research' },
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
        <div class="demo-banner-copy">
          <span class="demo-banner-icon" aria-hidden="true">◆</span>
          <span>Demo workspace — fictional data in a separate database (Notewell sample). Live providers and schedules are off.</span>
        </div>
        <div class="demo-banner-actions">
          <button type="button" class="btn btn-sm btn-demo-exit" data-switch-demo="false">Exit Demo → Set Up My Brand</button>
        </div>
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

/* ------------------------------------------------------------------ *
 * Presentation helpers. Series colour follows the entity, never the
 * rank (§11.1); every rate carries its n (§7, §19.6 #4).
 * ------------------------------------------------------------------ */

/** Categorical slots in fixed order. Slot 0 is always the brand (§11.1). */
export const SERIES_SLOTS = /** @type {const} */ (['s1', 's2', 's3', 's4']);

/** Sample size below which a rate is flagged as thin evidence (§7). */
export const LOW_SAMPLE_N = 5;

/**
 * Slot name for a colour index: the fifth entity onwards is grey, never a new hue
 * (§19.6 #2).
 * @param {number} index
 * @returns {string} `s1`…`s4` or `other`
 */
export function seriesSlot(index) {
  return index >= 0 && index < SERIES_SLOTS.length ? SERIES_SLOTS[index] : 'other';
}

/**
 * CSS colour for a colour index, as a custom-property reference.
 * @param {number} index
 * @returns {string}
 */
export function seriesColor(index) {
  const slot = seriesSlot(index);
  return slot === 'other' ? 'var(--muted)' : `var(--${slot})`;
}

/**
 * 10px colour chip that stands in for colouring the label text (§11.1).
 * @param {number} index
 * @returns {RawHtml}
 */
export function chip(index) {
  return html`<span class="chip chip-${seriesSlot(index)}" aria-hidden="true"></span>`;
}

/**
 * @param {number|null|undefined} value 0..1
 * @param {number} [digits]
 * @returns {string} e.g. `61%`, or `—` when there is no value
 */
export function pct(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * @param {number|null|undefined} value
 * @param {number} [digits]
 * @returns {string}
 */
export function num(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/**
 * @typedef {Object} Rate
 * @property {number|null} p
 * @property {number} n
 * @property {number|null} [lo]
 * @property {number|null} [hi]
 */

/**
 * "low sample" badge for rates resting on almost nothing (§7).
 * @param {number} n
 * @returns {RawHtml|string}
 */
export function lowSampleBadge(n) {
  if (n >= LOW_SAMPLE_N) return '';
  return html`<span class="tag tag-low" title="Fewer than ${LOW_SAMPLE_N} valid answers — treat as anecdote">low sample</span>`;
}

/**
 * A rate, its 95% interval and its sample size, in one string of markup. There is no
 * variant of this helper that omits n — that is the point of it (§19.6 #4).
 *
 * @param {Rate|null|undefined} rate
 * @param {Object} [opts]
 * @param {boolean} [opts.badge] append the low-sample badge
 * @returns {RawHtml}
 */
export function rateWithCI(rate, { badge = true } = {}) {
  if (!rate || rate.p === null || rate.p === undefined || !Number.isFinite(rate.p)) {
    const n = Number(rate?.n ?? 0);
    return html`<span class="rate"><span class="rate-value">—</span>
      <span class="rate-n">n=${n}</span></span>`;
  }
  const half =
    typeof rate.lo === 'number' && typeof rate.hi === 'number' && Number.isFinite(rate.lo) && Number.isFinite(rate.hi)
      ? Math.round(((rate.hi - rate.lo) / 2) * 100)
      : null;
  return html`<span class="rate"
    ><span class="rate-value">${pct(rate.p)}</span>${half === null ? '' : html` <span class="rate-ci">± ${half}</span>`},
    <span class="rate-n">n=${rate.n}</span>${badge ? lowSampleBadge(Number(rate.n ?? 0)) : ''}</span
  >`;
}

/**
 * Change line for a KPI tile: arrow, points, and the words that say what it compares
 * (never colour alone, §11.3).
 *
 * @param {number|null} deltaPoints percentage points
 * @param {string} [against]
 * @returns {RawHtml|string}
 */
export function deltaLine(deltaPoints, against = 'vs prior 7d') {
  if (deltaPoints === null || !Number.isFinite(deltaPoints)) {
    return html`<p class="kpi-delta muted">no comparable prior window</p>`;
  }
  const rounded = Math.round(deltaPoints * 10) / 10;
  if (rounded === 0) return html`<p class="kpi-delta muted">no change ${against}</p>`;
  const up = rounded > 0;
  return html`<p class="kpi-delta ${up ? 'is-up' : 'is-down'}">
    <span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(rounded)} pts ${against}
  </p>`;
}

/** @type {Record<string, {icon: string, word: string}>} */
const SEVERITY = {
  good: { icon: '✓', word: 'good' },
  warning: { icon: '⚠', word: 'warning' },
  serious: { icon: '✖', word: 'serious' },
};

/**
 * Severity chip — icon AND word, so the meaning never rides on colour alone (§11.3).
 * @param {string} severity
 * @returns {RawHtml}
 */
export function severityChip(severity) {
  const s = SEVERITY[severity] ?? { icon: '•', word: severity };
  return html`<span class="sev sev-${severity}"><span aria-hidden="true">${s.icon}</span> ${s.word}</span>`;
}

/** Letter-marks for the provider badges on answer cards (§11.4). */
const PROVIDER_LETTER = /** @type {Record<string, string>} */ ({
  openai: 'C',
  anthropic: 'A',
  gemini: 'G',
  perplexity: 'P',
});

/** Exact measurement-surface labels. Agent surfaces are never aliased to consumer products. */
export const SURFACE_LABEL = /** @type {Record<string, string>} */ ({
  'openai-api': 'OpenAI API',
  'anthropic-api': 'Anthropic API',
  'gemini-api': 'Gemini API',
  'perplexity-api': 'Perplexity API',
  ...Object.fromEntries(AGENT_ROUTES.map((route) => [route.id, route.label])),
});

/** Consumer-product names, so the UI never shows a bare API slug. */
export const PROVIDER_LABEL = /** @type {Record<string, string>} */ ({
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
});

/**
 * @param {string} provider
 * @param {string|null} [surface]
 * @returns {RawHtml}
 */
export function providerBadge(provider, surface = null) {
  const label = surface && isAgentSurface(surface)
    ? SURFACE_LABEL[surface]
    : PROVIDER_LABEL[provider] ?? provider;
  return html`<span class="pbadge"
    ><span class="pbadge-mark" aria-hidden="true">${PROVIDER_LETTER[provider] ?? '?'}</span>${label}</span
  >`;
}

/**
 * Relative time in words. Takes `now` so callers can render deterministically in tests.
 * @param {string|null|undefined} iso UTC ISO-8601
 * @param {number} [nowMs]
 * @returns {string}
 */
export function relTime(iso, nowMs = Date.now()) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const secs = Math.round((nowMs - then) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

/**
 * Money, from `core/cost.js` output only — never a hardcoded figure (§19.6 #13).
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function usd(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not tracked';
  return `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/**
 * Shorten a long string for a label, on a word boundary where possible.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Mask a secret into a prefix-only hint (`sk-...****`) with zero trailing key characters.
 * @param {string|null|undefined} secret
 * @returns {string|null}
 */
export function maskOnboardingHint(secret) {
  const s = String(secret ?? '').trim();
  if (s === '') return null;
  if (s.length <= 8) return '****';
  const dash = s.indexOf('-');
  const prefix = dash > 0 && dash <= 5 ? s.slice(0, dash + 1) : s.slice(0, 3);
  return `${prefix}...****`;
}

/**
 * Check whether an executable exists and is runnable on PATH without spawning a process.
 * @param {string} executable
 * @param {string|undefined} [pathEnv]
 * @returns {boolean}
 */
export function detectCliExecutable(executable, pathEnv = process.env.PATH) {
  const target = String(executable ?? '').trim();
  if (target === '') return false;
  const checkFile = (/** @type {string} */ candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (target.includes('/') || target.includes('\\')) {
    return checkFile(resolve(target));
  }
  for (const dir of String(pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    if (checkFile(join(dir, target))) return true;
  }
  return false;
}

/**
 * @typedef {'stopped'|'configured'|'connected'|'collecting'|'stale'} ScheduleRuntimeState
 */

/**
 * @typedef {'Stopped'|'Configured (Consent Suspended / Needs Quote)'|'Connected (Active in Running Server)'|'Collecting Now'|'Stale (Missed or Failed Run)'} ScheduleBadgeLabel
 */

/**
 * @typedef {Object} ScheduleBadgeInfo
 * @property {ScheduleRuntimeState} state
 * @property {ScheduleBadgeLabel} status
 * @property {'off'|'active'|'warn'|'collecting'} tone
 * @property {string} summary
 */

/**
 * Compute the canonical schedule health badge state so `/settings`, `/dashboard`, and
 * `/api/onboarding/state` explicitly distinguish configured vs connected vs collecting
 * vs stale vs stopped.
 *
 * @param {'api'|'subscription'} kind
 * @param {Object} opts
 * @param {ReturnType<typeof import('../core/tracking-health.js').trackingHealth>} opts.trackingHealth
 * @param {boolean} [opts.demo]
 * @param {boolean} [opts.hasSearch]
 * @param {boolean} [opts.recurringSearchApproved]
 * @param {boolean} [opts.collecting]
 * @returns {ScheduleBadgeInfo}
 */
export function scheduleStatusInfo(kind, opts) {
  const {
    trackingHealth,
    demo = false,
    hasSearch = false,
    recurringSearchApproved = false,
    collecting = false,
  } = opts;

  if (collecting && !demo) {
    return {
      state: 'collecting',
      status: 'Collecting Now',
      tone: 'collecting',
      summary: 'A live collection run is currently executing in this server process.',
    };
  }

  if (kind === 'api') {
    if (demo || !trackingHealth.api.enabled) {
      return {
        state: 'stopped',
        status: 'Stopped',
        tone: 'off',
        summary: demo
          ? 'Stopped while demo workspace is active.'
          : 'Stopped — no API provider key configured.',
      };
    }
    if (hasSearch && !recurringSearchApproved) {
      return {
        state: 'configured',
        status: 'Configured (Consent Suspended / Needs Quote)',
        tone: 'warn',
        summary: 'Saved configuration only — recurring web search awaits explicit quote consent.',
      };
    }
    if (trackingHealth.api.stale) {
      return {
        state: 'stale',
        status: 'Stale (Missed or Failed Run)',
        tone: 'warn',
        summary: 'Scheduled run missed or failed, or last observation is >48h old; missed runs do not auto-replay.',
      };
    }
    return {
      state: 'connected',
      status: 'Connected (Active in Running Server)',
      tone: 'active',
      summary: 'In-process scheduler timer connected in this running server (stops if Node exits).',
    };
  }

  if (!trackingHealth.subscription.configured) {
    return {
      state: 'stopped',
      status: 'Stopped',
      tone: 'off',
      summary: 'Stopped — no recurring subscription schedule saved.',
    };
  }
  if (demo || !trackingHealth.subscription.enabled || !trackingHealth.subscription.ready) {
    return {
      state: 'configured',
      status: 'Configured (Consent Suspended / Needs Quote)',
      tone: 'warn',
      summary: demo
        ? 'Saved in SQLite, paused while demo workspace is active.'
        : 'Saved configuration only — not collecting until CLI surface and quote consent match.',
    };
  }
  if (trackingHealth.subscription.stale) {
    return {
      state: 'stale',
      status: 'Stale (Missed or Failed Run)',
      tone: 'warn',
      summary: 'Scheduled run missed or failed, or last observation is >48h old; missed runs do not auto-replay.',
    };
  }
  return {
    state: 'connected',
    status: 'Connected (Active in Running Server)',
    tone: 'active',
    summary: 'In-process scheduler timer connected in this running server (stops if Node exits).',
  };
}

/**
 * Inspect whether an API or subscription collection run is currently executing in SQLite.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{api: boolean, subscription: boolean}}
 */
export function runningScheduleLanes(db) {
  const subRow = get(
    db,
    `SELECT 1 AS hit
       FROM runs
      WHERE status = 'running'
        AND (
          schedule_key = 'subscription-agent'
          OR EXISTS (
            SELECT 1 FROM responses
             WHERE responses.run_id = runs.id
               AND responses.surface IN (${AGENT_SURFACES_SQL})
          )
        )
      LIMIT 1`,
  );
  const apiRow = get(
    db,
    `SELECT 1 AS hit
       FROM runs
      WHERE status = 'running'
        AND (
          schedule_key = 'api-panel'
          OR trigger = 'api'
          OR EXISTS (
            SELECT 1 FROM responses
             WHERE responses.run_id = runs.id
               AND responses.surface LIKE '%-api'
          )
        )
      LIMIT 1`,
  );
  return { api: Boolean(apiRow), subscription: Boolean(subRow) };
}

/**
 * Render a Schedule Health Status Badge pill.
 * @param {ScheduleBadgeInfo} info
 * @returns {RawHtml}
 */
export function scheduleStatusBadge(info) {
  return html`<span class="status-pill status-pill-${info.tone}" data-schedule-state="${info.state}">${info.status}</span>`;
}
