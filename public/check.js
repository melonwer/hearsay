/**
 * Site X-Ray Workbench client script (`/check`).
 *
 * Plain vanilla ES module — zero dependencies, zero build step, zero inline handlers,
 * zero `innerHTML` (strictly uses `textContent` and safe DOM builders to comply with
 * Hearsay's `script-src 'self'` CSP and XSS invariants).
 */

/**
 * Validate a URL before assigning it to an `<a href>` attribute.
 * Only permits relative paths (`/`) and `http:` / `https:` URLs.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Create a DOM element safely without `innerHTML`.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...(Node|string|number|null|undefined|false)} children
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'className') {
      node.className = String(val);
    } else if (key === 'dataset' && typeof val === 'object') {
      for (const [dk, dv] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
        if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
      }
    } else if (key === 'style' && typeof val === 'object') {
      for (const [sk, sv] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
        if (sv !== null && sv !== undefined) {
          /** @type {any} */ (node.style)[sk] = String(sv);
        }
      }
    } else if (key === 'href') {
      const checked = safeHref(val);
      if (checked !== null) node.setAttribute('href', checked);
    } else if (val === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(val));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
  return node;
}

/**
 * @param {string} text
 * @param {'good'|'warn'|'crit'|'info'|'neutral'|'stack'} [tone]
 * @returns {HTMLElement}
 */
function pill(text, tone = 'neutral') {
  return el('span', { className: `xray-pill xray-pill-${tone}` }, text);
}

/**
 * @param {unknown} status
 * @returns {'good'|'warn'|'crit'|'neutral'}
 */
function statusTone(status) {
  const norm = String(status ?? '').toLowerCase();
  if (norm === 'pass' || norm === 'ok' || norm === 'allowed' || norm === 'default_allowed') return 'good';
  if (norm === 'attention' || norm === 'warn' || norm === 'warning' || norm === 'high' || norm === 'medium') return 'warn';
  if (norm === 'critical' || norm === 'fail' || norm === 'blocked' || norm === 'blocked_hard_gate' || norm === 'error') return 'crit';
  return 'neutral';
}

/**
 * @param {unknown} status
 * @returns {string}
 */
function statusLabel(status) {
  const norm = String(status ?? '').toLowerCase();
  if (norm === 'blocked_hard_gate') return 'Blocked (Hard Gate)';
  if (norm === 'critical' || norm === 'fail') return 'Critical';
  if (norm === 'attention' || norm === 'warn') return 'Needs attention';
  if (norm === 'pass') return 'Pass';
  return String(status ?? 'Unknown');
}

/**
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

/**
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function relTime(iso) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return String(iso);
  const secs = Math.round((Date.now() - then) / 1000);
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
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Collect concise stack/CDN/WAF badge labels from a report or summary.
 * @param {any} report
 * @param {any} summary
 * @returns {Array<{label: string, tone: 'stack'|'warn'|'crit'}>}
 */
function collectStackBadges(report, summary) {
  /** @type {Array<{label: string, tone: 'stack'|'warn'|'crit'}>} */
  const badges = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {string} label @param {'stack'|'warn'|'crit'} tone */
  const add = (label, tone = 'stack') => {
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    badges.push({ label, tone });
  };

  const stack = report?.stack;
  if (stack && typeof stack === 'object' && Array.isArray(stack.technologies)) {
    const byId = new Map(stack.technologies.map((/** @type {any} */ t) => [t.id, t.name || t.id]));
    if (stack.primaryFramework) add(`Framework: ${byId.get(stack.primaryFramework) ?? stack.primaryFramework}`, 'stack');
    if (stack.primaryCms) add(`CMS: ${byId.get(stack.primaryCms) ?? stack.primaryCms}`, 'stack');
    if (stack.primaryCdn) add(`CDN: ${byId.get(stack.primaryCdn) ?? stack.primaryCdn}`, 'stack');
    if (stack.primaryHosting && stack.primaryHosting !== stack.primaryCdn) {
      add(`Host: ${byId.get(stack.primaryHosting) ?? stack.primaryHosting}`, 'stack');
    }
  } else if (Array.isArray(summary?.stack)) {
    for (const s of summary.stack) add(String(s), 'stack');
  } else if (report?.headers?.cdnDetected) {
    add(`CDN: ${report.headers.cdnDetected}`, 'stack');
  }

  const waf = report?.waf ?? stack?.waf ?? null;
  const wafState = waf?.state ?? summary?.wafState ?? null;
  if (wafState && wafState !== 'none') {
    const vendor = waf?.vendor ? ` (${waf.vendor})` : '';
    const tone = wafState === 'challenge_or_block_intercepted' ? 'crit' : 'warn';
    add(`WAF: ${wafState}${vendor}`, tone);
  }
  return badges;
}

/**
 * Main controller for `/check`.
 */
function initSiteXrayWorkbench() {
  const workbench = document.getElementById('xray-workbench');
  const form = document.getElementById('xray-form');
  if (!workbench || !(form instanceof HTMLFormElement)) return;

  const urlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-url'));
  const submitBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('xray-submit'));
  const errorBox = document.getElementById('xray-error');
  const singleCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-single'));
  const maxPagesInput = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-max-pages'));
  const timeoutInput = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-timeout'));
  const vsInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('xray-vs'));
  const browserCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-browser'));
  const cachingCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-caching'));
  const ignoreRobotsCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-ignore-robots'));
  const includeAuthCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('xray-include-auth'));

  const progressPanel = document.getElementById('xray-progress-panel');
  const progressText = document.getElementById('xray-progress-text');
  const progressCount = document.getElementById('xray-progress-count');
  const progressTrack = document.getElementById('xray-progress-track');
  const progressBar = document.getElementById('xray-progress-bar');
  const progressLog = document.getElementById('xray-progress-log');

  const scopeBanner = document.getElementById('xray-scope-banner');
  const insightsPanel = document.getElementById('xray-panel-insights');
  const diffPanel = document.getElementById('xray-panel-diff');
  const botsPanel = document.getElementById('xray-panel-bots');
  const competitorsPanel = document.getElementById('xray-panel-competitors');
  const historyContainer = document.getElementById('xray-history-container');
  const driftPanel = document.getElementById('xray-drift-panel');
  const refreshHistoryBtn = document.getElementById('xray-refresh-history');

  const badges = {
    insights: document.getElementById('xray-badge-insights'),
    diff: document.getElementById('xray-badge-diff'),
    bots: document.getElementById('xray-badge-bots'),
    competitors: document.getElementById('xray-badge-competitors'),
    history: document.getElementById('xray-badge-history'),
  };

  /** @type {EventSource|null} */
  let activeStream = null;
  /** @type {number|null} */
  let activeCheckId = null;
  /** @type {any[]} */
  let cachedHistory = [];

  /* ---------------------------------------------------------------- *
   * Tabs (click + keyboard arrow navigation)
   * ---------------------------------------------------------------- */

  const tabButtons = /** @type {HTMLButtonElement[]} */ ([...workbench.querySelectorAll('[data-xray-tab]')]);
  const tabPanels = /** @type {HTMLElement[]} */ ([...workbench.querySelectorAll('[data-xray-panel]')]);

  /** @param {string} name */
  function activateTab(name) {
    for (const btn of tabButtons) {
      const isMatch = btn.getAttribute('data-xray-tab') === name;
      btn.classList.toggle('is-active', isMatch);
      btn.setAttribute('aria-selected', String(isMatch));
      btn.tabIndex = isMatch ? 0 : -1;
    }
    for (const panel of tabPanels) {
      panel.hidden = panel.getAttribute('data-xray-panel') !== name;
    }
  }

  tabButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-xray-tab');
      if (tab) activateTab(tab);
    });
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const nextIdx =
        event.key === 'ArrowRight'
          ? (idx + 1) % tabButtons.length
          : (idx - 1 + tabButtons.length) % tabButtons.length;
      const nextBtn = tabButtons[nextIdx];
      const tab = nextBtn?.getAttribute('data-xray-tab');
      if (nextBtn && tab) {
        activateTab(tab);
        nextBtn.focus();
      }
    });
  });

  /**
   * @param {HTMLElement|null} node
   * @param {string|number|null} text
   * @param {'crit'|'warn'|'good'|'neutral'} [tone]
   */
  function setTabBadge(node, text, tone = 'neutral') {
    if (!node) return;
    node.classList.remove('is-crit', 'is-warn', 'is-good');
    if (text === null || text === '' || text === 0) {
      node.textContent = '';
      node.hidden = true;
      return;
    }
    node.textContent = String(text);
    node.hidden = false;
    if (tone !== 'neutral') node.classList.add(`is-${tone}`);
  }

  /** @param {string|null} message */
  function showFormError(message) {
    if (!errorBox) return;
    if (!message) {
      errorBox.textContent = '';
      errorBox.hidden = true;
      return;
    }
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  /** @param {boolean} running */
  function setRunningState(running) {
    if (submitBtn) {
      submitBtn.disabled = running;
      submitBtn.textContent = running ? 'Running Site X-Ray…' : 'Run Site X-Ray';
    }
  }

  if (singleCheck && maxPagesInput) {
    const syncSingle = () => {
      maxPagesInput.disabled = singleCheck.checked;
    };
    singleCheck.addEventListener('change', syncSingle);
    syncSingle();
  }

  /* ---------------------------------------------------------------- *
   * Live SSE Progress UI
   * ---------------------------------------------------------------- */

  /** @param {string} message @param {number} pct @param {string} countLabel */
  function updateProgress(message, pct, countLabel) {
    if (!progressPanel) return;
    progressPanel.hidden = false;
    if (progressText) progressText.textContent = message;
    if (progressCount) progressCount.textContent = countLabel;
    const clamped = clampPct(pct);
    if (progressBar) progressBar.style.width = `${clamped}%`;
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }

  /** @param {string} line */
  function appendProgressLog(line) {
    if (!progressLog || !line) return;
    const li = el('li', {}, line);
    progressLog.prepend(li);
    while (progressLog.children.length > 8) {
      progressLog.lastElementChild?.remove();
    }
  }

  function resetProgressLog() {
    if (progressLog) progressLog.replaceChildren();
  }

  /* ---------------------------------------------------------------- *
   * Render 1: Honest Scope & Hard-Gate Banner
   * ---------------------------------------------------------------- */

  /** @param {any} summary @param {any} report */
  function renderScopeBanner(summary, report) {
    if (!scopeBanner) return;
    scopeBanner.hidden = false;

    const id = summary?.id ?? activeCheckId;
    const domain = summary?.domain ?? report?.domain ?? 'unknown';
    const url = summary?.url ?? report?.finalUrl ?? report?.requestedUrl ?? '';
    const status = summary?.status ?? report?.crawlStatus ?? report?.summary?.grade ?? 'unknown';
    const mode = summary?.mode ?? report?.mode ?? 'crawl';
    const audited = summary?.auditedCount ?? report?.counts?.audited ?? 0;
    const skipped = summary?.skippedCount ?? report?.counts?.skipped ?? 0;
    const errored = summary?.erroredCount ?? report?.counts?.errored ?? 0;
    const proseParity = summary?.proseParityPct ?? report?.proseParityPct ?? null;
    const payloadRatio = summary?.medianPayloadRatio ?? report?.extraction?.forensics?.payloadToProseRatio ?? null;
    const timingMs = typeof report?.timingMs === 'number' ? report.timingMs : null;
    const pageTitle = report?.meta?.title ?? report?.pages?.[0]?.title ?? '';

    const actions = el('div', { className: 'xray-scope-actions' });
    if (id) {
      actions.append(
        el(
          'a',
          {
            id: 'xray-export-html',
            className: 'btn btn-sm',
            href: `/api/check/${encodeURIComponent(String(id))}?format=html`,
            download: true,
          },
          'Export HTML Report',
        ),
        el(
          'a',
          {
            id: 'xray-view-html',
            className: 'btn btn-sm',
            href: `/api/check/${encodeURIComponent(String(id))}?format=html&inline=1`,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'Printable View',
        ),
      );
    }

    const head = el(
      'div',
      { className: 'xray-scope-head' },
      el(
        'div',
        { className: 'xray-scope-title-wrap' },
        el(
          'div',
          { className: 'xray-scope-topline' },
          pill(statusLabel(status), statusTone(status)),
          el('h2', { className: 'xray-scope-domain' }, domain),
          id ? el('span', { className: 'muted xray-scope-check-id' }, `Check #${id}`) : null,
          timingMs !== null ? el('span', { className: 'muted xray-scope-timing' }, `${(timingMs / 1000).toFixed(1)}s`) : null,
        ),
        el('p', { className: 'xray-scope-url' }, el('code', {}, url)),
        pageTitle ? el('p', { className: 'xray-scope-page-title muted' }, pageTitle) : null,
      ),
      actions,
    );

    const pillsRow = el(
      'div',
      { className: 'xray-pill-row', 'aria-label': 'Crawl coverage and detected stack' },
      pill(`Audited: ${audited}`, audited > 0 ? 'good' : 'crit'),
      pill(`Skipped: ${skipped}`, skipped > 0 ? 'warn' : 'neutral'),
      pill(`Errored: ${errored}`, errored > 0 ? 'crit' : 'neutral'),
      pill(`Mode: ${mode}`, 'info'),
      proseParity !== null ? pill(`Prose parity: ${proseParity}%`, proseParity < 70 ? 'crit' : 'good') : null,
      payloadRatio !== null ? pill(`Payload/Prose: ${payloadRatio}x`, payloadRatio > 25 ? 'warn' : 'neutral') : null,
    );

    for (const badge of collectStackBadges(report, summary)) {
      pillsRow.append(pill(badge.label, badge.tone));
    }

    /** @type {HTMLElement|null} */
    let hardGateNode = null;
    if (report?.hardGate?.triggered) {
      hardGateNode = el(
        'div',
        { id: 'xray-hard-gate', className: 'xray-hard-gate', role: 'alert' },
        el('strong', {}, 'Hard Infrastructure Gate — Downstream Not Observed'),
        el(
          'p',
          {},
          'Reason: ',
          el('code', {}, String(report.hardGate.reason ?? 'blocked')),
          report.hardGate.detail ? ` — ${report.hardGate.detail}` : '',
        ),
      );
    }

    const scopeNote = report?.scopeSummary
      ? el('p', { className: 'muted xray-scope-note' }, report.scopeSummary)
      : null;

    /** @type {HTMLElement|null} */
    let disclaimersNode = null;
    if (Array.isArray(report?.disclaimers) && report.disclaimers.length > 0) {
      const list = el('ul', { className: 'xray-disclaimer-list' });
      for (const d of report.disclaimers) list.append(el('li', {}, String(d)));
      disclaimersNode = el(
        'details',
        { className: 'xray-disclaimers' },
        el('summary', {}, `Epistemic scope & measurement notes (${report.disclaimers.length})`),
        list,
      );
    }

    scopeBanner.replaceChildren(
      ...[head, pillsRow, hardGateNode, scopeNote, disclaimersNode].filter(
        (n) => n !== null,
      ),
    );
  }

  /* ---------------------------------------------------------------- *
   * Render 2: Tab 1 — Insights & Fixes (Clusters + Outliers + Recipes)
   * ---------------------------------------------------------------- */

  /** @param {any} report */
  function renderInsightsTab(report) {
    if (!insightsPanel) return;
    const clusters = report?.clusters ?? { siteWide: [], templateClusters: [], pageOutliers: [] };
    const siteWide = Array.isArray(clusters.siteWide) ? clusters.siteWide : [];
    const templateClusters = Array.isArray(clusters.templateClusters) ? clusters.templateClusters : [];
    const pageOutliers = Array.isArray(clusters.pageOutliers) ? clusters.pageOutliers : [];
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    const recipes = Array.isArray(report?.remediation?.recipes) ? report.remediation.recipes : [];
    const pages = Array.isArray(report?.pages) ? report.pages : [];
    const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
    const errored = Array.isArray(report?.errored) ? report.errored : [];

    const critCount = report?.summary?.criticalCount ?? findings.filter((/** @type {any} */ f) => f.severity === 'critical').length;
    const warnCount = report?.summary?.warningCount ?? findings.filter((/** @type {any} */ f) => f.severity === 'warning' || f.severity === 'attention').length;
    const totalIssues = critCount + warnCount;
    setTabBadge(
      badges.insights,
      totalIssues > 0 ? totalIssues : null,
      critCount > 0 ? 'crit' : warnCount > 0 ? 'warn' : 'good',
    );

    const frag = document.createDocumentFragment();

    // 1. Template-Clustered Findings ("Fix 1 template → fix N pages")
    if (templateClusters.length > 0) {
      const sec = el('div', { className: 'xray-section' });
      sec.append(
        el('h3', {}, `Template-clustered findings (${templateClusters.length})`),
        el('p', { className: 'muted' }, 'Issues recurring across pages that share a URL template. Fix the shared layout once to resolve every affected page.'),
      );
      const list = el('ul', { className: 'xray-finding-list' });
      for (const c of templateClusters) {
        const sev = String(c.severity ?? 'info');
        const li = el(
          'li',
          { className: `xray-finding-item xray-sev-${statusTone(sev)}` },
          el(
            'div',
            { className: 'xray-finding-head' },
            pill(sev, statusTone(sev)),
            el(
              'strong',
              {},
              'Fix 1 template (',
              el('code', {}, String(c.template ?? 'unknown')),
              `) → fix ${c.affectedCount ?? 0} of ${c.totalInTemplate ?? c.affectedCount ?? 0} page(s)`,
            ),
            el('code', { className: 'muted' }, String(c.ruleId ?? '')),
          ),
          el('p', {}, String(c.summary ?? '')),
        );
        if (Array.isArray(c.sampleUrls) && c.sampleUrls.length > 0) {
          const urlsWrap = el('div', { className: 'xray-sample-urls' });
          for (const u of c.sampleUrls.slice(0, 5)) {
            urlsWrap.append(el('code', { className: 'xray-url-chip' }, String(u)));
          }
          li.append(urlsWrap);
        }
        list.append(li);
      }
      sec.append(list);
      frag.append(sec);
    }

    // 2. Site-Wide Findings
    if (siteWide.length > 0) {
      const sec = el('div', { className: 'xray-section' });
      sec.append(el('h3', {}, `Site-wide findings (${siteWide.length})`));
      const list = el('ul', { className: 'xray-finding-list' });
      for (const s of siteWide) {
        const sev = String(s.severity ?? 'info');
        list.append(
          el(
            'li',
            { className: `xray-finding-item xray-sev-${statusTone(sev)}` },
            el(
              'div',
              { className: 'xray-finding-head' },
              pill(sev, statusTone(sev)),
              el('strong', {}, String(s.summary ?? s.ruleId ?? '')),
              el('code', { className: 'muted' }, String(s.ruleId ?? '')),
            ),
            s.category ? el('p', { className: 'muted' }, `Category: ${s.category} · Affected: ${s.affectedCount ?? 0}/${s.totalPages ?? 0} page(s)`) : null,
          ),
        );
      }
      sec.append(list);
      frag.append(sec);
    }

    // 3. Page Outliers
    if (pageOutliers.length > 0) {
      const sec = el('div', { className: 'xray-section' });
      sec.append(el('h3', {}, `Page outliers (${pageOutliers.length})`));
      const list = el('ul', { className: 'xray-finding-list' });
      for (const o of pageOutliers) {
        const sev = String(o.severity ?? 'info');
        list.append(
          el(
            'li',
            { className: `xray-finding-item xray-sev-${statusTone(sev)}` },
            el(
              'div',
              { className: 'xray-finding-head' },
              pill(sev, statusTone(sev)),
              el('strong', {}, String(o.title ?? o.ruleId ?? '')),
              el('code', { className: 'muted' }, String(o.ruleId ?? '')),
            ),
            el('p', { className: 'xray-outlier-url' }, el('code', {}, String(o.url ?? '')), o.template ? ` (${o.template})` : ''),
            o.detail ? el('p', {}, String(o.detail)) : null,
          ),
        );
      }
      sec.append(list);
      frag.append(sec);
    }

    // Fallback when report has findings but no clusters (e.g., v1 or single-page fixture)
    if (templateClusters.length === 0 && siteWide.length === 0 && pageOutliers.length === 0) {
      const sec = el('div', { className: 'xray-section' });
      sec.append(el('h3', {}, `Observed findings (${findings.length})`));
      if (findings.length === 0) {
        sec.append(el('p', { className: 'muted' }, 'No issues detected on audited pages.'));
      } else {
        const list = el('ul', { className: 'xray-finding-list' });
        for (const f of findings) {
          const sev = String(f.severity ?? 'info');
          list.append(
            el(
              'li',
              { className: `xray-finding-item xray-sev-${statusTone(sev)}` },
              el(
                'div',
                { className: 'xray-finding-head' },
                pill(sev, statusTone(sev)),
                el('strong', {}, String(f.title ?? f.id ?? '')),
                el('code', { className: 'muted' }, String(f.id ?? '')),
              ),
              f.detail ? el('p', {}, String(f.detail)) : null,
            ),
          );
        }
        sec.append(list);
      }
      frag.append(sec);
    }

    // 4. Stack-Aware Copy-Paste Remediation Cards
    const remSec = el('div', { className: 'xray-section' });
    remSec.append(el('h3', {}, `Framework & CDN remediation recipes (${recipes.length})`));
    if (recipes.length === 0) {
      remSec.append(el('p', { className: 'muted' }, 'No concrete remediation recipes triggered for the detected stack and findings.'));
    } else {
      const grid = el('div', { className: 'xray-remediation-grid' });
      for (const r of recipes) {
        const prio = String(r.priority ?? 'medium');
        const card = el('article', { className: `xray-recipe-card xray-sev-${statusTone(prio)}` });
        card.append(
          el(
            'div',
            { className: 'xray-recipe-head' },
            el('div', { className: 'xray-recipe-badges' }, pill(prio, statusTone(prio)), pill(String(r.stackName ?? r.stackId ?? 'Stack'), 'stack'), pill(String(r.layer ?? 'config'), 'neutral')),
            el('h4', {}, String(r.title ?? r.id ?? 'Remediation')),
          ),
          r.trigger ? el('p', { className: 'muted xray-recipe-trigger' }, `Trigger: ${r.trigger}`) : null,
        );
        if (Array.isArray(r.steps) && r.steps.length > 0) {
          const ol = el('ol', { className: 'xray-recipe-steps' });
          for (const step of r.steps) ol.append(el('li', {}, String(step)));
          card.append(ol);
        }
        if (typeof r.snippet === 'string' && r.snippet.trim() !== '') {
          const copyBtn = el('button', { type: 'button', className: 'btn btn-sm xray-copy-btn' }, 'Copy snippet');
          const snippetText = r.snippet;
          copyBtn.addEventListener('click', async () => {
            try {
              if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(snippetText);
                copyBtn.textContent = 'Copied';
                setTimeout(() => {
                  copyBtn.textContent = 'Copy snippet';
                }, 1800);
              }
            } catch {
              copyBtn.textContent = 'Copy failed';
            }
          });
          card.append(
            el(
              'div',
              { className: 'xray-snippet-wrap' },
              el(
                'div',
                { className: 'xray-snippet-bar' },
                el('span', { className: 'muted' }, String(r.snippetLanguage ?? 'text')),
                copyBtn,
              ),
              el('pre', { className: 'xray-code' }, el('code', {}, snippetText)),
            ),
          );
        }
        grid.append(card);
      }
      remSec.append(grid);
    }
    frag.append(remSec);

    // 5. Audited / Skipped / Errored URLs detail
    if (pages.length > 0 || skipped.length > 0 || errored.length > 0) {
      const covSec = el('details', { className: 'xray-section xray-coverage-details' });
      covSec.append(
        el(
          'summary',
          {},
          `Page coverage breakdown (${pages.length} audited, ${skipped.length} skipped, ${errored.length} errored)`,
        ),
      );
      if (pages.length > 0) {
        const tbody = el('tbody');
        for (const pg of pages) {
          tbody.append(
            el(
              'tr',
              {},
              el('td', {}, el('code', {}, String(pg.finalUrl ?? pg.url ?? ''))),
              el('td', {}, el('code', {}, String(pg.template ?? '—'))),
              el('td', { className: 'num' }, String(pg.status ?? '—')),
              el('td', { className: 'num' }, typeof pg.visibleWordCount === 'number' ? String(pg.visibleWordCount) : '—'),
              el('td', { className: 'num' }, formatBytes(pg.htmlBytes)),
              el('td', { className: 'num' }, typeof pg.payloadToProseRatio === 'number' ? `${pg.payloadToProseRatio}x` : '—'),
              el('td', { className: 'num' }, String(Array.isArray(pg.findings) ? pg.findings.length : 0)),
            ),
          );
        }
        covSec.append(
          el(
            'div',
            { className: 'table-scroll' },
            el(
              'table',
              { className: 'table' },
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', {}, 'Audited URL'),
                  el('th', {}, 'Template'),
                  el('th', { className: 'num' }, 'HTTP'),
                  el('th', { className: 'num' }, 'Words'),
                  el('th', { className: 'num' }, 'HTML'),
                  el('th', { className: 'num' }, 'Ratio'),
                  el('th', { className: 'num' }, 'Findings'),
                ),
              ),
              tbody,
            ),
          ),
        );
      }
      if (skipped.length > 0) {
        const sList = el('ul', { className: 'xray-compact-list' });
        for (const s of skipped.slice(0, 40)) {
          sList.append(
            el(
              'li',
              {},
              pill(String(s.reason ?? 'skipped'), s.reason === 'robots_disallowed' || s.reason === 'ssrf_blocked' ? 'warn' : 'neutral'),
              ' ',
              el('code', {}, String(s.url ?? '')),
              s.detail ? ` — ${s.detail}` : '',
            ),
          );
        }
        covSec.append(el('h4', {}, `Skipped URLs (${skipped.length})`), sList);
      }
      if (errored.length > 0) {
        const eList = el('ul', { className: 'xray-compact-list' });
        for (const e of errored.slice(0, 40)) {
          eList.append(
            el(
              'li',
              {},
              pill(String(e.reason ?? 'error'), 'crit'),
              ' ',
              el('code', {}, String(e.url ?? '')),
              e.error ? ` — ${e.error}` : '',
            ),
          );
        }
        covSec.append(el('h4', {}, `Errored URLs (${errored.length})`), eList);
      }
      frag.append(covSec);
    }

    insightsPanel.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- *
   * Render 3: Tab 2 — Bot vs. Human Diff + Truncation Budget + Payload
   * ---------------------------------------------------------------- */

  /** @param {any} report */
  function renderDiffTab(report) {
    if (!diffPanel) return;
    const payload = report?.payload ?? null;
    const ext = report?.extraction ?? null;
    const forensics = ext?.forensics ?? null;
    const bvh = report?.botVsHumanDiff ?? null;
    const mdNeg = report?.markdownNegotiation ?? null;

    // Tab severity badge for truncation / hydration gap
    const parity = report?.proseParityPct ?? (bvh && typeof bvh.proseParityRatio === 'number' ? Number((bvh.proseParityRatio * 100).toFixed(1)) : null);
    if (parity !== null && parity < 70) {
      setTabBadge(badges.diff, `${parity}%`, 'crit');
    } else if (payload?.truncationRisks?.any || forensics?.rawHtmlCliffs?.exceeds2MB) {
      setTabBadge(badges.diff, 'Cliff', 'warn');
    } else if (parity !== null) {
      setTabBadge(badges.diff, `${parity}%`, 'good');
    } else {
      setTabBadge(badges.diff, null);
    }

    const frag = document.createDocumentFragment();

    // 1. Visual Truncation Budget Bars (30KB / 100KB / 300KB / 2MB + 50K / 100K Markdown)
    if (payload) {
      const rawMax = 2 * 1024 * 1024;
      const htmlBytes = Number(payload.htmlBytes ?? 0);
      const rawPct = clampPct((htmlBytes / rawMax) * 100);
      const h1Bytes = payload.offsets?.firstH1Bytes ?? null;
      const h1Pct = typeof h1Bytes === 'number' ? clampPct((h1Bytes / rawMax) * 100) : null;
      const rawTone =
        htmlBytes > rawMax
          ? 'crit'
          : htmlBytes > 300 * 1024 || payload.truncationRisks?.coreContentPast100KB
            ? 'warn'
            : 'good';

      const budgetCard = el('div', { className: 'xray-budget-card' });
      budgetCard.append(
        el(
          'div',
          { className: 'xray-budget-head' },
          el('strong', {}, 'Raw HTML Truncation Budget'),
          el('span', { className: 'muted' }, `${formatBytes(htmlBytes)} / 2.0 MB Googlebot cap`),
        ),
      );

      const rawTrack = el('div', { className: 'xray-budget-track' });
      rawTrack.append(
        el('div', {
          className: `xray-budget-fill is-${rawTone}`,
          style: { width: `${Math.max(rawPct, htmlBytes > 0 ? 1.5 : 0)}%` },
        }),
      );
      // Threshold ticks at 30KB (~1.46%), 100KB (~4.88%), 300KB (~14.65%)
      for (const [label, bytes] of [
        ['30KB', 30 * 1024],
        ['100KB', 100 * 1024],
        ['300KB', 300 * 1024],
      ]) {
        const left = clampPct((/** @type {number} */ (bytes) / rawMax) * 100);
        rawTrack.append(
          el('div', {
            className: 'xray-budget-tick',
            style: { left: `${left}%` },
            title: `${label} cliff`,
          }),
        );
      }
      if (h1Pct !== null) {
        rawTrack.append(
          el('div', {
            className: 'xray-budget-h1-marker',
            style: { left: `${h1Pct}%` },
            title: `First H1 at ${formatBytes(h1Bytes)}`,
          }),
        );
      }
      budgetCard.append(rawTrack);

      budgetCard.append(
        el(
          'div',
          { className: 'xray-cliff-marks' },
          el(
            'span',
            { className: payload.truncationRisks?.contentStartsAfter30KB ? 'is-hit' : '' },
            `30 KB start: ${payload.truncationRisks?.contentStartsAfter30KB ? 'EXCEEDED' : 'ok'}`,
          ),
          el(
            'span',
            { className: payload.truncationRisks?.coreContentPast100KB ? 'is-hit' : '' },
            `100 KB core: ${payload.truncationRisks?.coreContentPast100KB ? 'EXCEEDED' : 'ok'}`,
          ),
          el(
            'span',
            { className: payload.truncationRisks?.pageExceeds300KB ? 'is-hit' : '' },
            `300 KB page: ${payload.truncationRisks?.pageExceeds300KB ? 'EXCEEDED' : 'ok'}`,
          ),
          el(
            'span',
            { className: forensics?.rawHtmlCliffs?.exceeds2MB ? 'is-hit' : '' },
            `2 MB Googlebot: ${forensics?.rawHtmlCliffs?.exceeds2MB ? 'EXCEEDED' : 'ok'}`,
          ),
          h1Bytes !== null ? el('span', { className: 'muted' }, `First H1: ${formatBytes(h1Bytes)}`) : null,
        ),
      );

      // Markdown character budget (50K warn / 100K fail)
      const mdChars = typeof ext?.extracted?.charCount === 'number' ? ext.extracted.charCount : null;
      if (mdChars !== null) {
        const mdPct = clampPct((mdChars / 100_000) * 100);
        const mdTone = mdChars > 100_000 ? 'crit' : mdChars > 50_000 ? 'warn' : 'good';
        budgetCard.append(
          el(
            'div',
            { className: 'xray-budget-head xray-budget-subhead' },
            el('strong', {}, `Extracted Markdown Budget (${ext.extracted.engine ?? 'fallback'})`),
            el(
              'span',
              { className: 'muted' },
              `${mdChars.toLocaleString('en-US')} chars (~${ext.extracted.estimatedTokens ?? 0} tokens) · 50K warn / 100K fail`,
            ),
          ),
          el(
            'div',
            { className: 'xray-budget-track' },
            el('div', {
              className: `xray-budget-fill is-${mdTone}`,
              style: { width: `${Math.max(mdPct, mdChars > 0 ? 1.5 : 0)}%` },
            }),
            el('div', { className: 'xray-budget-tick', style: { left: '50%' }, title: '50K chars warning' }),
          ),
        );
      }

      frag.append(budgetCard);
    }

    // 2. Payload-to-Prose Stacked Breakdown
    if (forensics && forensics.rawHtmlBytes > 0) {
      const total = Math.max(1, forensics.rawHtmlBytes);
      const proseBytes = Math.min(total, forensics.visibleProseBytes ?? 0);
      const rscBytes = Math.min(total - proseBytes, (forensics.nextFlightBytes ?? 0) + (forensics.nextDataBytes ?? 0));
      const inlineJsCss = Math.min(
        Math.max(0, total - proseBytes - rscBytes),
        Math.max(0, (forensics.inlineJsCssBytes ?? 0) - rscBytes),
      );
      const mediaBytes = Math.min(
        Math.max(0, total - proseBytes - rscBytes - inlineJsCss),
        (forensics.inlineSvgBytes ?? 0) + (forensics.base64ImageBytes ?? 0),
      );
      const markupBytes = Math.max(0, total - proseBytes - rscBytes - inlineJsCss - mediaBytes);

      const segs = [
        { cls: 'seg-prose', label: 'Prose', bytes: proseBytes, pct: clampPct((proseBytes / total) * 100) },
        { cls: 'seg-rsc', label: 'Next RSC/Data', bytes: rscBytes, pct: clampPct((rscBytes / total) * 100) },
        { cls: 'seg-jscss', label: 'Inline JS/CSS', bytes: inlineJsCss, pct: clampPct((inlineJsCss / total) * 100) },
        { cls: 'seg-media', label: 'SVG/Base64', bytes: mediaBytes, pct: clampPct((mediaBytes / total) * 100) },
        { cls: 'seg-markup', label: 'Markup', bytes: markupBytes, pct: clampPct((markupBytes / total) * 100) },
      ];

      const bar = el('div', { className: 'xray-stacked-bar', 'aria-label': 'Payload-to-prose breakdown' });
      const legend = el('div', { className: 'xray-legend' });
      for (const s of segs) {
        if (s.pct > 0) {
          bar.append(el('span', { className: s.cls, style: { width: `${s.pct}%` }, title: `${s.label}: ${formatBytes(s.bytes)}` }));
        }
        legend.append(
          el(
            'span',
            { className: 'xray-legend-item' },
            el('i', { className: `xray-dot ${s.cls}` }),
            `${s.label} ${formatBytes(s.bytes)} (${s.pct}%)`,
          ),
        );
      }

      const fPills = el(
        'div',
        { className: 'xray-pill-row' },
        pill(`Ratio: ${forensics.payloadToProseRatio}x`, forensics.payloadToProseRatio > 25 ? 'warn' : 'good'),
        pill(`Weight tier: ${forensics.rawHtmlCliffs?.tier ?? 'ok'}`, forensics.rawHtmlCliffs?.exceeds2MB ? 'crit' : 'neutral'),
        pill(`DOM nodes: ~${forensics.domNodeEstimate ?? 0} (${forensics.domNodeStatus ?? 'ok'})`, forensics.domNodeStatus === 'high' ? 'warn' : 'neutral'),
        pill(`Collapsed text: ${((forensics.collapsedShare ?? 0) * 100).toFixed(1)}%`, forensics.collapsedShareWarning ? 'warn' : 'neutral'),
        pill(`data-nosnippet: ${((forensics.dataNosnippetShare ?? 0) * 100).toFixed(1)}%`, forensics.dataNosnippetWarning ? 'warn' : 'neutral'),
        forensics.jsonLdCrossCheck
          ? pill(
              `JSON-LD visible: ${forensics.jsonLdCrossCheck.matchedCount}/${forensics.jsonLdCrossCheck.checkedCount}`,
              forensics.jsonLdCrossCheck.missingCount > 0 ? 'warn' : 'neutral',
            )
          : null,
      );

      frag.append(
        el(
          'div',
          { className: 'xray-budget-card' },
          el(
            'div',
            { className: 'xray-budget-head' },
            el('strong', {}, 'Payload-to-Prose Breakdown'),
            el('span', { className: 'muted' }, `${formatBytes(total)} total raw HTML`),
          ),
          bar,
          legend,
          fPills,
        ),
      );
    }

    // 3. Split-Pane What AI Bots See vs What Humans / Edge See
    const botMd = bvh?.bot?.markdown ?? ext?.extracted?.markdown ?? '';
    const botWords = bvh?.bot?.wordCount ?? ext?.extracted?.wordCount ?? payload?.visibleWordCount ?? 0;
    const botHeadings = bvh?.bot?.headings?.length ?? ext?.extracted?.headings?.length ?? payload?.headingCount ?? 0;
    const botTables = bvh?.bot?.tablesCount ?? ext?.extracted?.tablesCount ?? payload?.tableCount ?? 0;
    const botCode = bvh?.bot?.codeBlocksCount ?? ext?.extracted?.codeBlocksCount ?? 0;

    const humanMd = bvh?.human?.markdown ?? null;
    const edgeMd = bvh?.edge?.markdown ?? (mdNeg?.supported ? mdNeg.markdown : null);

    if (bvh) {
      const parityStr = bvh.proseParityRatio !== null ? `${(bvh.proseParityRatio * 100).toFixed(1)}%` : '—';
      const missingCount = Array.isArray(bvh.missingHeadings) ? bvh.missingHeadings.length : 0;
      const lostTables = Number(bvh.lostTables ?? 0);
      const lostCode = Number(bvh.lostCodeBlocks ?? 0);

      frag.append(
        el(
          'div',
          { className: 'xray-pill-row' },
          pill(`Prose Parity: ${parityStr}`, (bvh.proseParityRatio ?? 1) < 0.7 ? 'crit' : 'good'),
          pill(`Missing Headings: ${missingCount}`, missingCount > 0 ? 'crit' : 'good'),
          pill(`Lost Tables: ${lostTables}`, lostTables > 0 ? 'crit' : 'good'),
          pill(`Lost Code Blocks: ${lostCode}`, lostCode > 0 ? 'warn' : 'good'),
          bvh.diffSummary
            ? pill(`+${bvh.diffSummary.addedLines} human-only / -${bvh.diffSummary.removedLines} bot-only lines`, 'info')
            : null,
        ),
      );

      if (missingCount > 0) {
        const callout = el(
          'div',
          { className: 'xray-callout xray-callout-warn' },
          el('strong', {}, 'Missing headings (invisible to non-JS AI bots): '),
        );
        for (const h of bvh.missingHeadings.slice(0, 15)) {
          callout.append(el('code', { className: 'xray-url-chip' }, `h${h.level} ${h.text}`), ' ');
        }
        frag.append(callout);
      }
    }

    const rightTitle = humanMd !== null
      ? `What Humans See (Rendered DOM · ${bvh.human.wordCount} words, ${bvh.human.headings?.length ?? 0} headings, ${bvh.human.tablesCount ?? 0} tables, ${bvh.human.codeBlocksCount ?? 0} code)`
      : edgeMd !== null
        ? `Edge Markdown (Accept: text/markdown · ${bvh?.edge?.wordCount ?? mdNeg?.wordCount ?? 0} words)`
        : 'What Humans See (Headless Browser DOM)';

    const rightBody = humanMd !== null
      ? el('pre', { className: 'xray-md-preview' }, truncate(humanMd || '(empty)', 8000))
      : edgeMd !== null
        ? el('pre', { className: 'xray-md-preview' }, truncate(edgeMd || '(empty)', 8000))
        : el(
            'div',
            { className: 'xray-md-empty muted' },
            el('p', {}, `Browser DOM diff status: ${report?.browserDiff?.status ?? 'skipped'}.`),
            el(
              'p',
              {},
              report?.browserDiff?.reason ??
                'Enable "Headless Browser DOM Diff (--browser)" in Advanced options to compare non-JS bot output side-by-side against the rendered browser DOM.',
            ),
          );

    const split = el(
      'div',
      { className: 'xray-split-diff' },
      el(
        'div',
        { className: 'xray-diff-pane' },
        el(
          'div',
          { className: 'xray-pane-title' },
          `What AI Bots See (Raw HTML → Markdown · ${botWords} words, ${botHeadings} headings, ${botTables} tables, ${botCode} code)`,
        ),
        el('pre', { className: 'xray-md-preview' }, truncate(botMd || '(empty — 0 visible words extracted)', 8000)),
      ),
      el(
        'div',
        { className: 'xray-diff-pane' },
        el('div', { className: 'xray-pane-title' }, rightTitle),
        rightBody,
      ),
    );
    frag.append(split);

    // Optional separate Edge Markdown preview when BOTH human DOM and Edge Markdown were observed
    if (humanMd !== null && edgeMd !== null) {
      frag.append(
        el(
          'details',
          { className: 'xray-section' },
          el('summary', {}, `Edge Markdown response (Accept: text/markdown · ${bvh?.edge?.wordCount ?? mdNeg?.wordCount ?? 0} words)`),
          el('pre', { className: 'xray-md-preview' }, truncate(edgeMd, 8000)),
        ),
      );
    }

    // 4. Line-level diff hunks
    if (bvh && Array.isArray(bvh.hunks) && bvh.hunks.length > 0) {
      const hunksBox = el('div', { className: 'xray-diff-hunks' });
      for (const hunk of bvh.hunks.slice(0, 8)) {
        hunksBox.append(
          el(
            'div',
            { className: 'xray-hunk-hdr' },
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ),
        );
        for (const line of (hunk.lines ?? []).slice(0, 40)) {
          const cls = line.type === 'add' ? 'is-add' : line.type === 'remove' ? 'is-rem' : 'is-ctx';
          const prefix = line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ';
          hunksBox.append(el('div', { className: `xray-diff-line ${cls}` }, `${prefix}${line.line}`));
        }
      }
      frag.append(
        el('div', { className: 'xray-section' }, el('h3', {}, 'Line-level diff hunks (- bot-only / + human-only)'), hunksBox),
      );
    }

    diffPanel.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- *
   * Render 4: Tab 3 — 18-Bot Access Matrix & Policy Signals
   * ---------------------------------------------------------------- */

  /** @param {any} report */
  function renderBotsTab(report) {
    if (!botsPanel) return;
    const policy = report?.robotsPolicy ?? null;
    const allBots = Array.isArray(policy?.bots) ? policy.bots : [];
    const crawlers = allBots.filter((/** @type {any} */ b) => b.category !== 'policy_signal');
    const policySignals = allBots.filter((/** @type {any} */ b) => b.category === 'policy_signal');
    const legacyCrawlers = Array.isArray(report?.robotsTxt?.crawlers) ? report.robotsTxt.crawlers : [];
    const mdNeg = report?.markdownNegotiation ?? null;
    const llmsTxt = report?.llmsTxt ?? null;
    const condCache = report?.conditionalCaching ?? null;

    const blockedCount =
      typeof report?.aiBotsAllowed?.blockedBots?.length === 'number'
        ? report.aiBotsAllowed.blockedBots.length
        : crawlers.filter((/** @type {any} */ b) => !b.allowed).length;
    setTabBadge(
      badges.bots,
      blockedCount > 0 ? `${blockedCount} blocked` : null,
      blockedCount > 0 ? 'warn' : 'good',
    );

    const frag = document.createDocumentFragment();

    // Policy & Edge Delivery Diagnostics Cards
    const cardsGrid = el('div', { className: 'xray-policy-grid' });

    // Card A: Cloudflare Managed robots.txt
    const cf = policy?.cloudflareManaged ?? null;
    const cfCard = el('div', { className: 'xray-policy-card' });
    cfCard.append(
      el('h4', {}, 'Cloudflare Managed robots.txt'),
      cf?.detected
        ? el(
            'div',
            {},
            el('p', {}, pill('Managed block detected', cf.contradictions?.length > 0 ? 'crit' : 'warn'), ` Lines ${cf.startLine ?? '?'}–${cf.endLine ?? '?'}`),
            cf.managedAgents?.length > 0
              ? el('p', { className: 'muted' }, `Managed agents: ${cf.managedAgents.join(', ')}`)
              : null,
            cf.contradictions?.length > 0
              ? el(
                  'ul',
                  { className: 'xray-compact-list' },
                  ...cf.contradictions.map((/** @type {any} */ c) =>
                    el('li', {}, pill('Override', 'crit'), ` ${c.agent}: ${c.detail}`),
                  ),
                )
              : el('p', { className: 'muted' }, 'No contradictions between Cloudflare Managed block and origin directives.'),
          )
        : el('p', { className: 'muted' }, 'No Cloudflare Managed robots.txt injection detected.'),
    );
    cardsGrid.append(cfCard);

    // Card B: Content-Signal & AIPREF
    const cs = policy?.contentSignals ?? null;
    const csEntries = cs?.effective ? Object.entries(cs.effective).map(([k, v]) => `${k}=${v}`) : [];
    const csCard = el('div', { className: 'xray-policy-card' });
    csCard.append(
      el('h4', {}, 'Content-Signal & AIPREF Policy'),
      el(
        'p',
        {},
        csEntries.length > 0
          ? pill(csEntries.join(', '), cs.suppressesSearch || cs.suppressesAiInput ? 'warn' : 'info')
          : el('span', { className: 'muted' }, 'No Content-Signal directives declared.'),
      ),
      cs?.conflicts?.length > 0
        ? el(
            'ul',
            { className: 'xray-compact-list' },
            ...cs.conflicts.map((/** @type {any} */ c) => el('li', {}, pill('Conflict', 'crit'), ` ${c.detail}`)),
          )
        : null,
      policy?.aiprefTrainingOptOut?.detected
        ? el(
            'p',
            { className: 'muted' },
            'AIPREF ',
            el('code', {}, '__usage_ai-training'),
            policy.aiprefTrainingOptOut.disallowed
              ? ' is disallowed (training opt-out only — does not block AI search retrieval).'
              : ' detected.',
          )
        : null,
    );
    cardsGrid.append(csCard);

    // Card C: Accept: text/markdown & Vary: Accept
    const mdCard = el('div', { className: 'xray-policy-card' });
    mdCard.append(
      el('h4', {}, 'Edge Markdown (Accept: text/markdown)'),
      mdNeg?.probed
        ? el(
            'div',
            {},
            el(
              'p',
              {},
              pill(mdNeg.supported ? 'Supported' : 'Not supported', mdNeg.supported ? 'good' : 'neutral'),
              mdNeg.contentType ? el('span', { className: 'muted' }, ` ${mdNeg.contentType}`) : null,
            ),
            mdNeg.supported
              ? el(
                  'p',
                  {},
                  pill(
                    mdNeg.varyHasAccept ? 'Vary: Accept present' : 'Missing Vary: Accept',
                    mdNeg.missingVaryAccept ? 'crit' : 'good',
                  ),
                  mdNeg.tokenCount !== null ? ` · ~${mdNeg.tokenCount} tokens` : '',
                )
              : null,
            mdNeg.csrEmptyShellTrap
              ? el('p', {}, pill('CSR Empty-Shell Trap', 'crit'), ' Edge Markdown returned empty/near-empty shell.')
              : null,
          )
        : el('p', { className: 'muted' }, 'Not probed (homepage did not return 2xx/3xx HTML).'),
    );
    cardsGrid.append(mdCard);

    // Card D: /llms.txt & 304 Caching
    const extraCard = el('div', { className: 'xray-policy-card' });
    extraCard.append(
      el('h4', {}, '/llms.txt & Conditional 304 Caching'),
      llmsTxt?.probed
        ? el(
            'p',
            {},
            '/llms.txt: ',
            llmsTxt.soft404
              ? pill('HTML soft-404 fallback', 'warn')
              : llmsTxt.present
                ? pill(`Present (HTTP ${llmsTxt.status})`, 'good')
                : pill(`Absent (HTTP ${llmsTxt.status ?? 'err'})`, 'neutral'),
          )
        : el('p', { className: 'muted' }, '/llms.txt not probed.'),
      condCache?.checked
        ? el(
            'p',
            {},
            '304 Caching: ',
            pill(
              condCache.supported304 ? '304 Not Modified supported' : `Returned HTTP ${condCache.status ?? 'n/a'}`,
              condCache.supported304 ? 'good' : 'warn',
            ),
          )
        : el('p', { className: 'muted' }, '304 check not enabled (toggle "Check 304 Caching" in Advanced options).'),
    );
    cardsGrid.append(extraCard);

    frag.append(cardsGrid);

    // 18-Bot Matrix Table
    const rowsSource = crawlers.length > 0 ? crawlers : legacyCrawlers;
    const botsTbody = el('tbody');
    for (const b of rowsSource) {
      const token = String(b.token ?? b.bot ?? '');
      const allowed = Boolean(b.allowed);
      botsTbody.append(
        el(
          'tr',
          {},
          el('td', {}, el('code', {}, token)),
          el('td', {}, String(b.vendor ?? '—')),
          el('td', {}, String(b.category ?? '—')),
          el('td', {}, b.executesJs === true ? 'Yes' : b.executesJs === false ? 'No' : '—'),
          el('td', {}, pill(allowed ? 'Allowed' : 'Blocked', allowed ? 'good' : 'crit')),
          el('td', {}, b.source === 'cloudflare_managed' ? pill('CF Managed', 'warn') : String(b.source ?? 'origin')),
          el('td', {}, b.matchedGroup ? el('code', {}, String(b.matchedGroup)) : '—'),
          el('td', {}, b.rule ? el('code', {}, String(b.rule)) : 'default allow'),
        ),
      );
    }

    frag.append(
      el(
        'div',
        { className: 'xray-section' },
        el(
          'h3',
          {},
          `AI Crawler Access Matrix (${rowsSource.filter((/** @type {any} */ b) => b.allowed).length}/${rowsSource.length} allowed)`,
        ),
        el(
          'div',
          { className: 'table-scroll' },
          el(
            'table',
            { className: 'table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', {}, 'Crawler'),
                el('th', {}, 'Vendor'),
                el('th', {}, 'Category'),
                el('th', {}, 'Executes JS'),
                el('th', {}, 'Access'),
                el('th', {}, 'Rule source'),
                el('th', {}, 'Matched group'),
                el('th', {}, 'Matched rule'),
              ),
            ),
            botsTbody,
          ),
        ),
      ),
    );

    // 3 Policy Signals Table (e.g. __usage_ai-training)
    if (policySignals.length > 0) {
      const sigTbody = el('tbody');
      for (const s of policySignals) {
        sigTbody.append(
          el(
            'tr',
            {},
            el('td', {}, el('code', {}, String(s.token ?? ''))),
            el('td', {}, String(s.vendor ?? 'AIPREF / Policy')),
            el('td', {}, pill(s.allowed ? 'Allowed / Unset' : 'Disallowed (Opt-Out)', s.allowed ? 'neutral' : 'info')),
            el('td', {}, s.rule ? el('code', {}, String(s.rule)) : 'not set'),
          ),
        );
      }
      frag.append(
        el(
          'div',
          { className: 'xray-section' },
          el('h3', {}, `Policy signals (${policySignals.length})`),
          el('p', { className: 'muted' }, 'Non-crawler usage/training preference tokens (such as AIPREF __usage_ai-training) tracked separately from search retrieval crawlers.'),
          el(
            'div',
            { className: 'table-scroll' },
            el(
              'table',
              { className: 'table' },
              el(
                'thead',
                {},
                el('tr', {}, el('th', {}, 'Token'), el('th', {}, 'Standard / Vendor'), el('th', {}, 'State'), el('th', {}, 'Rule')),
              ),
              sigTbody,
            ),
          ),
        ),
      );
    }

    botsPanel.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- *
   * Render 5: Tab 4 — Competitor X-Ray Matrix + Winner Deltas
   * ---------------------------------------------------------------- */

  /** @param {any} report */
  function renderCompetitorsTab(report) {
    if (!competitorsPanel) return;
    const xray = report?.competitorXray ?? null;
    if (!xray || !Array.isArray(xray.rows) || xray.rows.length < 2) {
      setTabBadge(badges.competitors, null);
      competitorsPanel.replaceChildren(
        el(
          'div',
          { className: 'empty-state xray-empty' },
          el('h3', {}, 'No competitor comparison in this check'),
          el('p', { className: 'muted' }, 'Open Advanced options above and add up to 3 competitor URLs (--vs) to compare AI crawler access, prose parity, payload weight, Edge Markdown support, and WAF friction side by side.'),
        ),
      );
      return;
    }

    const compLeads = Array.isArray(xray.competitorLeads) ? xray.competitorLeads : [];
    const targetLeads = Array.isArray(xray.targetLeads) ? xray.targetLeads : [];
    setTabBadge(
      badges.competitors,
      compLeads.length > 0 ? `${compLeads.length} behind` : `${xray.competitors?.length ?? 1} vs`,
      compLeads.length > 0 ? 'warn' : 'good',
    );

    const frag = document.createDocumentFragment();

    const tbody = el('tbody');
    for (const row of xray.rows) {
      const botsStr = row.aiBotsAllowed ? `${row.aiBotsAllowed.allowed}/${row.aiBotsAllowed.total}` : '—';
      tbody.append(
        el(
          'tr',
          { className: row.isTarget ? 'xray-target-row' : '' },
          el(
            'td',
            {},
            el('strong', {}, String(row.domain ?? '')),
            row.isTarget ? ' ' : null,
            row.isTarget ? pill('Target', 'info') : null,
          ),
          el('td', {}, pill(statusLabel(row.status), statusTone(row.status))),
          el('td', { className: 'num' }, `${row.audited}/${row.skipped}/${row.errored}`),
          el('td', { className: 'num' }, botsStr),
          el('td', { className: 'num' }, row.proseParityPct !== null ? `${row.proseParityPct}%` : '—'),
          el('td', { className: 'num' }, row.payloadToProseRatio !== null ? `${row.payloadToProseRatio}x` : '—'),
          el('td', { className: 'num' }, row.rawWordsHomepage !== null ? String(row.rawWordsHomepage) : '—'),
          el('td', {}, pill(row.markdownNegotiation ? 'Yes' : 'No', row.markdownNegotiation ? 'good' : 'neutral')),
          el('td', {}, Array.isArray(row.stack) && row.stack.length > 0 ? row.stack.join(', ') : '—'),
          el('td', {}, String(row.wafState ?? 'none')),
          el('td', { className: 'num' }, String(row.criticalCount ?? 0)),
        ),
      );
    }

    frag.append(
      el(
        'div',
        { className: 'xray-section' },
        el('h3', {}, 'Side-by-side Competitor X-Ray matrix'),
        el(
          'div',
          { className: 'table-scroll' },
          el(
            'table',
            { className: 'table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', {}, 'Domain'),
                el('th', {}, 'Status'),
                el('th', { className: 'num' }, 'Aud/Skip/Err'),
                el('th', { className: 'num' }, 'AI Bots'),
                el('th', { className: 'num' }, 'Prose Parity'),
                el('th', { className: 'num' }, 'Payload/Prose'),
                el('th', { className: 'num' }, 'Home Words'),
                el('th', {}, 'Edge MD'),
                el('th', {}, 'Stack'),
                el('th', {}, 'WAF'),
                el('th', { className: 'num' }, 'Critical'),
              ),
            ),
            tbody,
          ),
        ),
      ),
    );

    const deltasGrid = el('div', { className: 'xray-deltas-grid' });
    const compLeadCard = el('div', { className: 'xray-policy-card' }, el('h4', {}, `Where competitors lead (${compLeads.length})`));
    if (compLeads.length === 0) {
      compLeadCard.append(el('p', { className: 'muted' }, 'No competitor leads detected on tracked metrics.'));
    } else {
      const ul = el('ul', { className: 'xray-compact-list' });
      for (const d of compLeads) ul.append(el('li', {}, pill(d.metric, 'warn'), ` ${d.summary}`));
      compLeadCard.append(ul);
    }

    const targetLeadCard = el('div', { className: 'xray-policy-card' }, el('h4', {}, `Where target leads (${targetLeads.length})`));
    if (targetLeads.length === 0) {
      targetLeadCard.append(el('p', { className: 'muted' }, 'No clear target leads on compared metrics.'));
    } else {
      const ul = el('ul', { className: 'xray-compact-list' });
      for (const d of targetLeads) ul.append(el('li', {}, pill(d.metric, 'good'), ` ${d.summary}`));
      targetLeadCard.append(ul);
    }

    deltasGrid.append(compLeadCard, targetLeadCard);
    frag.append(deltasGrid);

    competitorsPanel.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- *
   * Render 6: Tab 5 — History & Drift Timeline + Diff View
   * ---------------------------------------------------------------- */

  /**
   * @param {any[]} items
   * @param {number} index
   * @returns {number|null}
   */
  function findPrevId(items, index) {
    const cur = items[index];
    if (!cur) return null;
    for (let i = index + 1; i < items.length; i += 1) {
      if (items[i].domain === cur.domain) return items[i].id;
    }
    return index + 1 < items.length ? items[index + 1].id : null;
  }

  /** @param {any[]} items */
  function renderHistoryTable(items) {
    if (!historyContainer) return;
    cachedHistory = items;
    setTabBadge(badges.history, items.length > 0 ? items.length : null, 'neutral');

    if (items.length === 0) {
      historyContainer.replaceChildren(
        el('p', { className: 'muted', id: 'xray-history-empty' }, 'No saved Site X-Ray runs yet. Run an audit above to build a drift timeline in SQLite.'),
      );
      return;
    }

    const tbody = el('tbody', { id: 'xray-history-tbody' });
    items.forEach((item, idx) => {
      const prevId = findPrevId(items, idx);
      const actions = el(
        'div',
        { className: 'xray-row-actions' },
        el('button', { type: 'button', className: 'btn btn-sm', dataset: { loadCheck: item.id } }, 'Inspect'),
        prevId !== null
          ? el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm',
                dataset: { compareCurrent: item.id, compareBaseline: prevId },
              },
              'Compare vs Previous',
            )
          : null,
        el(
          'a',
          { className: 'btn btn-sm', href: `/api/check/${encodeURIComponent(String(item.id))}?format=html`, download: true },
          'HTML',
        ),
      );

      const stackWrap = el('div', { className: 'xray-stack-mini' });
      if (Array.isArray(item.stack) && item.stack.length > 0) {
        for (const s of item.stack.slice(0, 3)) stackWrap.append(pill(String(s), 'stack'));
      } else {
        stackWrap.append(el('span', { className: 'muted' }, '—'));
      }

      tbody.append(
        el(
          'tr',
          {
            className: activeCheckId === item.id ? 'is-selected' : '',
            dataset: { historyId: item.id },
          },
          el('td', {}, el('code', {}, `#${item.id}`)),
          el(
            'td',
            {},
            el('div', { className: 'xray-history-domain' }, el('strong', {}, String(item.domain ?? '')), ' ', el('span', { className: 'muted' }, `(${item.mode ?? 'crawl'})`)),
            el('div', { className: 'xray-history-url muted' }, el('code', {}, truncate(item.url ?? '', 64))),
          ),
          el('td', {}, pill(statusLabel(item.status), statusTone(item.status))),
          el('td', { className: 'num' }, `${item.auditedCount ?? 0} / ${item.skippedCount ?? 0} / ${item.erroredCount ?? 0}`),
          el('td', { className: 'num' }, `${item.criticalCount ?? 0} crit · ${item.warningCount ?? 0} warn`),
          el(
            'td',
            { className: 'num' },
            `${item.proseParityPct !== null && item.proseParityPct !== undefined ? `${item.proseParityPct}%` : '—'} / ${item.medianPayloadRatio !== null && item.medianPayloadRatio !== undefined ? `${item.medianPayloadRatio}x` : '—'}`,
          ),
          el('td', {}, stackWrap),
          el('td', { title: String(item.createdAt ?? '') }, relTime(item.createdAt)),
          el('td', {}, actions),
        ),
      );
    });

    historyContainer.replaceChildren(
      el(
        'div',
        { className: 'table-scroll' },
        el(
          'table',
          { className: 'table xray-history-table' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Check'),
              el('th', {}, 'Domain & URL'),
              el('th', {}, 'Status'),
              el('th', { className: 'num' }, 'Coverage'),
              el('th', { className: 'num' }, 'Findings'),
              el('th', { className: 'num' }, 'Parity / Ratio'),
              el('th', {}, 'Stack'),
              el('th', {}, 'When'),
              el('th', {}, 'Actions'),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  /** @param {any} payload */
  function renderDriftComparison(payload) {
    if (!driftPanel) return;
    const { current, baseline, diff } = payload;
    driftPanel.hidden = false;

    const closeBtn = el('button', { type: 'button', className: 'btn btn-sm' }, 'Close diff');
    closeBtn.addEventListener('click', () => {
      driftPanel.hidden = true;
      driftPanel.replaceChildren();
    });

    const head = el(
      'div',
      { className: 'xray-drift-head' },
      el(
        'div',
        {},
        pill(diff.hasRegression ? 'Regression detected' : 'No regressions', diff.hasRegression ? 'crit' : 'good'),
        ' ',
        el('strong', {}, `Check #${current.id} (${current.domain}) vs Baseline #${baseline.id} (${baseline.domain})`),
      ),
      closeBtn,
    );

    const pillsRow = el(
      'div',
      { className: 'xray-pill-row' },
      pill(`New critical: ${diff.newCriticalFindings?.length ?? 0}`, (diff.newCriticalFindings?.length ?? 0) > 0 ? 'crit' : 'good'),
      pill(`New findings: ${diff.newFindings?.length ?? 0}`, (diff.newFindings?.length ?? 0) > 0 ? 'warn' : 'neutral'),
      pill(`Resolved: ${diff.resolvedFindings?.length ?? 0}`, (diff.resolvedFindings?.length ?? 0) > 0 ? 'good' : 'neutral'),
      pill(`Newly blocked bots: ${diff.newlyBlockedBots?.length ?? 0}`, (diff.newlyBlockedBots?.length ?? 0) > 0 ? 'crit' : 'neutral'),
      pill(`Status regressions: ${diff.statusRegressions?.length ?? 0}`, (diff.statusRegressions?.length ?? 0) > 0 ? 'crit' : 'neutral'),
      pill(`Parity drops: ${diff.proseParityDrops?.length ?? 0}`, (diff.proseParityDrops?.length ?? 0) > 0 ? 'warn' : 'neutral'),
      diff.hardGateNewlyTriggered ? pill('Hard Gate newly triggered', 'crit') : null,
      diff.ignoredWordCountNoise > 0 ? pill(`${diff.ignoredWordCountNoise} word-count noise ignored (<20%)`, 'neutral') : null,
    );

    const grid = el('div', { className: 'xray-deltas-grid' });

    // Regressions / New Findings column
    const regCol = el('div', { className: 'xray-policy-card' }, el('h4', {}, 'Regressions & new issues'));
    const regList = el('ul', { className: 'xray-compact-list' });
    for (const f of diff.newFindings ?? []) {
      regList.append(
        el('li', {}, pill(f.severity, statusTone(f.severity)), ' ', el('strong', {}, f.title), ' ', el('code', {}, f.url)),
      );
    }
    for (const s of diff.statusRegressions ?? []) {
      regList.append(
        el('li', {}, pill('HTTP', 'crit'), ` ${s.url}: ${s.baselineStatus ?? 'n/a'} → ${s.currentStatus ?? 'n/a'}`),
      );
    }
    for (const b of diff.newlyBlockedBots ?? []) {
      regList.append(
        el('li', {}, pill('Bot blocked', 'crit'), ` ${b.bot} (${b.rule ?? 'disallowed'})`),
      );
    }
    for (const p of diff.proseParityDrops ?? []) {
      regList.append(
        el('li', {}, pill('Parity drop', 'warn'), ` ${p.url}: ${p.baselineProseParityPct}% → ${p.currentProseParityPct}% (-${p.dropPct}pp)`),
      );
    }
    for (const w of diff.wordCountChanges ?? []) {
      regList.append(
        el(
          'li',
          {},
          pill(w.direction === 'drop' ? 'Word drop' : 'Word gain', w.direction === 'drop' ? 'warn' : 'info'),
          ` ${w.url}: ${w.baselineWords} → ${w.currentWords} (${w.delta >= 0 ? '+' : ''}${w.delta})`,
        ),
      );
    }
    if (regList.children.length === 0) {
      regCol.append(el('p', { className: 'muted' }, 'No regressions or new findings since baseline.'));
    } else {
      regCol.append(regList);
    }

    // Resolved / Fixed column
    const fixCol = el('div', { className: 'xray-policy-card' }, el('h4', {}, 'Resolved issues & URL changes'));
    const fixList = el('ul', { className: 'xray-compact-list' });
    for (const r of diff.resolvedFindings ?? []) {
      fixList.append(el('li', {}, pill('Fixed', 'good'), ' ', el('strong', {}, r.title), ' ', el('code', {}, r.url)));
    }
    for (const u of (diff.addedUrls ?? []).slice(0, 10)) {
      fixList.append(el('li', {}, pill('+ URL', 'info'), ' ', el('code', {}, u)));
    }
    for (const u of (diff.removedUrls ?? []).slice(0, 10)) {
      fixList.append(el('li', {}, pill('- URL', 'warn'), ' ', el('code', {}, u)));
    }
    if (fixList.children.length === 0) {
      fixCol.append(el('p', { className: 'muted' }, 'No resolved issues or URL additions/removals.'));
    } else {
      fixCol.append(fixList);
    }

    grid.append(regCol, fixCol);
    driftPanel.replaceChildren(head, pillsRow, grid);
  }

  /* ---------------------------------------------------------------- *
   * Hydrate full report across all views
   * ---------------------------------------------------------------- */

  /** @param {any} summary @param {any} report */
  function renderFullCheck(summary, report) {
    if (summary?.id) activeCheckId = Number(summary.id);
    renderScopeBanner(summary, report);
    renderInsightsTab(report);
    renderDiffTab(report);
    renderBotsTab(report);
    renderCompetitorsTab(report);
    if (cachedHistory.length > 0) {
      renderHistoryTable(cachedHistory);
    }
  }

  async function refreshHistory() {
    try {
      const res = await fetch('/api/check/history?limit=25', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.items)) {
        renderHistoryTable(data.items);
      }
    } catch {
      /* ignore transient refresh failure */
    }
  }

  /** @param {number} id @param {boolean} [switchToInsights] */
  async function loadSavedCheck(id, switchToInsights = false) {
    showFormError(null);
    try {
      const res = await fetch(`/api/check/${encodeURIComponent(String(id))}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        showFormError(data?.error?.message ?? `Could not load check #${id}.`);
        return;
      }
      const { report, ...summary } = data;
      if (urlInput && typeof summary.url === 'string' && summary.url) {
        urlInput.value = summary.url;
      }
      renderFullCheck(summary, report);
      if (switchToInsights) activateTab('insights');
    } catch {
      showFormError(`Failed to load check #${id}.`);
    }
  }

  /** @param {number} currentId @param {number} baselineId */
  async function compareChecks(currentId, baselineId) {
    showFormError(null);
    try {
      const res = await fetch(
        `/api/check/diff?current=${encodeURIComponent(String(currentId))}&baseline=${encodeURIComponent(String(baselineId))}`,
        { headers: { Accept: 'application/json' } },
      );
      const data = await res.json();
      if (!res.ok) {
        showFormError(data?.error?.message ?? 'Could not compute drift diff.');
        return;
      }
      renderDriftComparison(data);
      activateTab('history');
      driftPanel?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    } catch {
      showFormError('Failed to fetch drift comparison.');
    }
  }

  /* ---------------------------------------------------------------- *
   * Form submission & SSE stream lifecycle
   * ---------------------------------------------------------------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(null);

    const rawUrl = (urlInput?.value ?? '').trim();
    if (!rawUrl) {
      showFormError('Enter an http:// or https:// URL to audit.');
      urlInput?.focus();
      return;
    }

    const vsRaw = (vsInput?.value ?? '')
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (vsRaw.length > 3) {
      showFormError('Enter at most 3 competitor URLs.');
      return;
    }

    const single = Boolean(singleCheck?.checked);
    const maxPages = single ? 1 : Math.min(25, Math.max(1, Number(maxPagesInput?.value ?? 15) || 15));
    const timeoutMs = Math.min(60_000, Math.max(500, Number(timeoutInput?.value ?? 10_000) || 10_000));

    if (activeStream) {
      activeStream.close();
      activeStream = null;
    }

    setRunningState(true);
    resetProgressLog();
    updateProgress(`Submitting Site X-Ray for ${rawUrl}…`, 5, `0 / ${maxPages} pages`);

    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          url: rawUrl,
          single,
          maxPages,
          vs: vsRaw,
          browser: Boolean(browserCheck?.checked),
          checkCaching: Boolean(cachingCheck?.checked),
          ignoreRobotsForOwnSite: Boolean(ignoreRobotsCheck?.checked),
          includeAuthRoutes: Boolean(includeAuthCheck?.checked),
          timeoutMs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (progressPanel) progressPanel.hidden = true;
        setRunningState(false);
        showFormError(data?.error?.message ?? 'Site X-Ray request was rejected.');
        return;
      }

      if (res.status === 200 && data.report) {
        if (progressPanel) progressPanel.hidden = true;
        setRunningState(false);
        renderFullCheck(data.summary, data.report);
        activateTab('insights');
        await refreshHistory();
        return;
      }

      const jobId = data.jobId;
      if (!jobId) {
        if (progressPanel) progressPanel.hidden = true;
        setRunningState(false);
        showFormError('Server did not return a Site X-Ray job ID.');
        return;
      }

      const stream = new EventSource(`/api/check/${encodeURIComponent(String(jobId))}/stream`);
      activeStream = stream;

      stream.addEventListener('progress', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          const audited = typeof payload.audited === 'number' ? payload.audited : 0;
          const total = typeof payload.maxPages === 'number' && payload.maxPages > 0 ? payload.maxPages : maxPages;
          const pct =
            payload.type === 'competitor'
              ? 85
              : payload.type === 'started'
                ? 8
                : Math.min(82, 10 + (audited / total) * 72);
          const msg = payload.message ?? `Auditing ${payload.finalUrl ?? payload.url ?? rawUrl}…`;
          updateProgress(msg, pct, `${audited} / ${total} pages audited`);
          appendProgressLog(msg);
        } catch {
          /* ignore malformed progress payload */
        }
      });

      stream.addEventListener('complete', async (ev) => {
        stream.close();
        if (activeStream === stream) activeStream = null;
        setRunningState(false);
        try {
          const payload = JSON.parse(ev.data);
          updateProgress('Site X-Ray complete.', 100, `${payload.summary?.auditedCount ?? 0} pages audited`);
          renderFullCheck(payload.summary, payload.report);
          activateTab('insights');
          await refreshHistory();
          setTimeout(() => {
            if (progressPanel && !activeStream) progressPanel.hidden = true;
          }, 1200);
        } catch {
          showFormError('Site X-Ray completed but the response could not be parsed.');
        }
      });

      stream.addEventListener('error', (ev) => {
        stream.close();
        if (activeStream === stream) activeStream = null;
        setRunningState(false);
        if (progressPanel) progressPanel.hidden = true;
        const rawData = /** @type {MessageEvent} */ (ev).data;
        if (typeof rawData === 'string' && rawData) {
          try {
            const payload = JSON.parse(rawData);
            showFormError(payload.message ?? 'Site X-Ray failed.');
            return;
          } catch {
            /* fall through */
          }
        }
        showFormError('Site X-Ray stream interrupted or failed.');
      });
    } catch {
      if (progressPanel) progressPanel.hidden = true;
      setRunningState(false);
      showFormError('Network error while starting Site X-Ray.');
    }
  });

  // Delegated history table actions (Inspect / Compare vs Previous)
  historyContainer?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;

    const loadId = target.getAttribute('data-load-check');
    if (loadId && /^\d+$/.test(loadId)) {
      void loadSavedCheck(Number(loadId), true);
      return;
    }

    const curId = target.getAttribute('data-compare-current');
    const baseId = target.getAttribute('data-compare-baseline');
    if (curId && baseId && /^\d+$/.test(curId) && /^\d+$/.test(baseId)) {
      void compareChecks(Number(curId), Number(baseId));
    }
  });

  refreshHistoryBtn?.addEventListener('click', () => {
    void refreshHistory();
  });

  // Hydrate initial SSR-selected check (if present)
  const initialId = workbench.getAttribute('data-initial-check-id');
  if (initialId && /^\d+$/.test(initialId)) {
    activeCheckId = Number(initialId);
    void loadSavedCheck(activeCheckId, false);
  }
}

initSiteXrayWorkbench();
