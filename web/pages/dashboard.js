/**
 * GET / — the dashboard (§11.3), top to bottom: KPI row, SOV trend, provider row,
 * competitor leaderboard, alerts panel, "Cited instead of you", latest receipts.
 *
 * Two rules bind every panel here. Every rate carries its n (§19.6 #4) — the helpers
 * in `layout.js` have no variant that omits it. And a window with no data renders as
 * an empty panel or a gap, never as an interpolated zero (§19.6 #10).
 */

import {
  chip,
  deltaLine,
  emptyState,
  esc,
  html,
  layout,
  num,
  pct,
  PROVIDER_LABEL,
  providerBadge,
  raw,
  rateWithCI,
  relTime,
  seriesColor,
  severityChip,
  truncate,
  usd,
} from '../layout.js';
import { barChartH, lineChart, meter, sparkline } from '../svg.js';
import { metrics, soft } from '../data.js';
import { brandEntity, colorIndexFor, latestReceipts, listAlerts, listEntities, PROVIDERS } from '../queries.js';

/** Window the dashboard reports on, in days (§7). */
export const WINDOW_DAYS = 30;

/**
 * Epoch day for a `YYYY-MM-DD` UTC date — the x unit `svg.js` plots in.
 * @param {string} date
 * @returns {number}
 */
function epochDay(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
}

/**
 * Difference in percentage points between the last 7 days and the 7 days before them.
 *
 * §7 exposes windows, not offsets, so the prior window is recovered by subtracting
 * counts: `prior = f(14d) − f(7d)`. That is exact, and it returns null — never zero —
 * when there is nothing in the prior window to compare against.
 *
 * @param {{n: number, k: number}|null} last7
 * @param {{n: number, k: number}|null} last14
 * @returns {number|null} percentage points
 */
export function deltaPoints(last7, last14) {
  if (!last7 || !last14) return null;
  const priorN = last14.n - last7.n;
  const priorK = last14.k - last7.k;
  if (priorN <= 0 || last7.n <= 0) return null;
  return (last7.k / last7.n - priorK / priorN) * 100;
}

/**
 * @typedef {Object} PageDeps
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../../core/config.js').Config} config
 */

/** A point in chart space: x is an epoch day, y the plotted value. */
/** @typedef {{x: number, y: number}} Point */

/** §7 `mentionRate` — null when the metric is unavailable or there is no brand. */
/** @typedef {{n: number, mentioned: number, p: number|null, lo?: number, hi?: number}|null} MentionStat */

/** §7 `recommendationRate` — same null contract. */
/** @typedef {{n: number, recommended: number, p: number|null}|null} RecStat */

/** §7 `shareOfVoice` row. */
/** @typedef {{entityId: number, name: string, isSelf: boolean, mentions: number, sov: number}} SovRow */

/** §7 `sovTrend` row — a day with no completed run simply has no entry (§19.6 #10). */
/** @typedef {{date: string, series: {entityId: number, sov: number, n: number}[]}} TrendDay */

/** §7 `citationGap` row. */
/** @typedef {{domain: string, count: number, sampleUrl: string, topPromptId: number|null}} GapRow */

/**
 * @typedef {Object} LeaderRow
 * @property {number} entityId
 * @property {string} name
 * @property {boolean} isSelf
 * @property {number} colorIndex series slot, fixed per entity (§11.1)
 * @property {number} sov
 * @property {number} mentions
 * @property {MentionStat} mentionRate
 * @property {RecStat} recRate
 * @property {number|null} avgRank
 * @property {number|null} delta7d percentage points against the prior 7 days
 */

/**
 * @typedef {Object} ProviderCard
 * @property {string} provider
 * @property {string} label consumer-product name, never the API slug
 * @property {boolean} enabled a key is configured, or the window already has answers
 * @property {number} n answers in the window
 * @property {{p: number|null, lo?: number, hi?: number}|null} brandMentionRate
 * @property {number|null} avgRank
 * @property {number|null} citationShare
 * @property {number} citationN
 * @property {string|null} lastError
 */

/**
 * @typedef {Object} DashboardKpis
 * @property {{value: number|null, delta: number|null, points: Point[]}} sov
 * @property {{rate: MentionStat, delta: number|null}} mentionRate
 * @property {{rate: {p: number|null, n: number}|null, delta: number|null}} recRate
 * @property {{n:number,spendUsd:number|null,spendKnownSubtotalUsd:number|null,
 *   spendCostStatus:'known'|'partial'|'unavailable',spendAttemptedCalls:number,points:Point[]}} answers
 * @property {number|null} phrasingSpread mean paraphrase spread, null below two paraphrases (§6.6)
 */

/**
 * @typedef {Object} DashboardView
 * @property {number} days window every panel reports on
 * @property {boolean} demo
 * @property {{id: number, name: string}|null} brand
 * @property {number} entityCount
 * @property {DashboardKpis} kpi
 * @property {{days: TrendDay[], names: Map<number, string>, series: {name: string, color: string, colorIndex: number, points: Point[]}[]}} trend
 * @property {ProviderCard[]} providers
 * @property {LeaderRow[]} leaderboard
 * @property {import('../queries.js').AlertRow[]} alerts
 * @property {GapRow[]} gap
 * @property {ReturnType<typeof latestReceipts>} receipts
 * @property {number} nowMs render clock, so `relTime` stays deterministic in tests
 */

/**
 * Assemble the dashboard view model. Statistics come from `core/metrics.js` through
 * the bridge; when a metric is unavailable the panel stays empty rather than filled in.
 *
 * @param {PageDeps} deps
 * @param {{days?: number, now?: Date}} [opts]
 * @returns {DashboardView}
 */
export function buildView({ db, config }, opts = {}) {
  const days = opts.days ?? WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const entities = listEntities(db);
  const colorIndex = colorIndexFor(entities);
  const brand = brandEntity(db);
  const brandId = brand?.id ?? null;

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {*} fallback
   * @returns {*}
   */
  const m = (name, args, fallback) => soft(/** @type {*} */ (metrics), name, { db, now, ...args }, fallback);

  /** @type {SovRow[]} */
  const sovNow = m('shareOfVoice', { days }, []);
  /** @type {typeof sovNow} */
  const sov7 = m('shareOfVoice', { days: 7 }, []);
  /** @type {typeof sovNow} */
  const sov14 = m('shareOfVoice', { days: 14 }, []);

  /**
   * @param {typeof sovNow} rows
   * @param {number|null} id
   * @returns {{n: number, k: number}|null}
   */
  const sovCounts = (rows, id) => {
    if (id === null || rows.length === 0) return null;
    const total = rows.reduce((sum, row) => sum + Number(row.mentions ?? 0), 0);
    const mine = rows.find((row) => row.entityId === id);
    if (!mine || total <= 0) return null;
    return { n: total, k: Number(mine.mentions ?? 0) };
  };

  /** @type {TrendDay[]} */
  const trendRows = m('sovTrend', { days }, []);

  /** @type {MentionStat} */
  const mentionRate = brandId === null ? null : m('mentionRate', { entityId: brandId, days }, null);
  /** @type {MentionStat} */
  const mention7 = brandId === null ? null : m('mentionRate', { entityId: brandId, days: 7 }, null);
  /** @type {MentionStat} */
  const mention14 = brandId === null ? null : m('mentionRate', { entityId: brandId, days: 14 }, null);

  /** @type {RecStat} */
  const recRate = brandId === null ? null : m('recommendationRate', { entityId: brandId, days }, null);
  /** @type {RecStat} */
  const rec7 = brandId === null ? null : m('recommendationRate', { entityId: brandId, days: 7 }, null);
  /** @type {RecStat} */
  const rec14 = brandId === null ? null : m('recommendationRate', { entityId: brandId, days: 14 }, null);

  /** @type {{provider:string,n:number,brandMentionRate:{p:number|null,lo?:number,hi?:number},avgRank:number|null,citationShare:number|null,citationN?:number,lastError:string|null}[]} */
  const providerRows = m('providerBreakdown', { days }, []);
  /** @type {{intentId:number,label:string,n:number,pooled:{p:number|null,lo?:number,hi?:number},rerunSpread:number|null,phrasingSpread:number|null,paraphraseCount:number}[]} */
  const intentRows = m('intentTable', { days }, []);
  /** @type {GapRow[]} */
  const gapRows = m('citationGap', { days, limit: 8 }, []);
  /** @type {{totalUsd:number|null,knownSubtotalUsd:number|null,
   * costStatus:'known'|'partial'|'unavailable',attemptedCalls:number}|null} */
  const spend = m('actualSpend', { days }, null);

  // Phrasing spread only means something once an intent actually has paraphrases (§6.6).
  const spreads = intentRows.filter(
    (row) => Number(row.paraphraseCount ?? 0) > 1 && Number.isFinite(Number(row.phrasingSpread)),
  );
  const phrasingSpread =
    spreads.length === 0 ? null : spreads.reduce((sum, row) => sum + Number(row.phrasingSpread), 0) / spreads.length;

  /** @type {LeaderRow[]} */
  const leaderboard = sovNow.map((row) => ({
    entityId: row.entityId,
    name: row.name,
    isSelf: Boolean(row.isSelf),
    colorIndex: colorIndex.get(row.entityId) ?? 99,
    sov: Number(row.sov ?? 0),
    mentions: Number(row.mentions ?? 0),
    /** @type {MentionStat} */
    mentionRate: m('mentionRate', { entityId: row.entityId, days }, null),
    /** @type {RecStat} */
    recRate: m('recommendationRate', { entityId: row.entityId, days }, null),
    /** @type {number|null} */
    avgRank: m('avgRank', { entityId: row.entityId, days }, null),
    delta7d: deltaPoints(sovCounts(sov7, row.entityId), sovCounts(sov14, row.entityId)),
  }));

  return {
    days,
    demo: config.demo,
    brand: brand ? { id: brand.id, name: brand.name } : null,
    entityCount: entities.length,
    kpi: {
      sov: {
        value: brandId === null ? null : (sovNow.find((row) => row.entityId === brandId)?.sov ?? null),
        delta: deltaPoints(sovCounts(sov7, brandId), sovCounts(sov14, brandId)),
        points: trendRows
          .map((day) => ({
            x: epochDay(day.date),
            y: Number(day.series.find((s) => s.entityId === brandId)?.sov ?? Number.NaN),
          }))
          .filter((point) => Number.isFinite(point.y)),
      },
      mentionRate: {
        rate: mentionRate,
        delta: deltaPoints(
          mention7 ? { n: mention7.n, k: mention7.mentioned } : null,
          mention14 ? { n: mention14.n, k: mention14.mentioned } : null,
        ),
      },
      recRate: {
        rate: recRate ? { p: recRate.p, n: recRate.n } : null,
        delta: deltaPoints(
          rec7 ? { n: rec7.n, k: rec7.recommended } : null,
          rec14 ? { n: rec14.n, k: rec14.recommended } : null,
        ),
      },
      answers: {
        n: mentionRate ? Number(mentionRate.n ?? 0) : 0,
        spendUsd: spend ? spend.totalUsd : null,
        spendKnownSubtotalUsd: spend?.knownSubtotalUsd ?? null,
        spendCostStatus: spend?.costStatus ?? 'unavailable',
        spendAttemptedCalls: spend?.attemptedCalls ?? 0,
        points: trendRows.map((day) => ({
          x: epochDay(day.date),
          y: day.series.reduce((sum, entry) => sum + Number(entry.n ?? 0), 0),
        })),
      },
      phrasingSpread,
    },
    trend: {
      days: trendRows,
      names: new Map(leaderboard.map((row) => [row.entityId, row.name])),
      series: leaderboard
        .slice()
        .sort((a, b) => (b.isSelf ? 1 : 0) - (a.isSelf ? 1 : 0) || b.sov - a.sov)
        .slice(0, 4)
        .map((row) => ({
          name: row.name,
          color: seriesColor(row.colorIndex),
          colorIndex: row.colorIndex,
          points: trendRows
            .map((day) => ({
              x: epochDay(day.date),
              y: Number(day.series.find((entry) => entry.entityId === row.entityId)?.sov ?? Number.NaN),
            }))
            .filter((point) => Number.isFinite(point.y)),
        })),
    },
    providers: PROVIDERS.map((id) => {
      const row = providerRows.find((entry) => entry.provider === id);
      return {
        provider: id,
        label: PROVIDER_LABEL[id] ?? id,
        enabled:
          Boolean(config.providers[/** @type {import('../../core/config.js').ProviderId} */ (id)]?.enabled) ||
          Boolean(row && Number(row.n) > 0),
        n: row ? Number(row.n ?? 0) : 0,
        brandMentionRate: row ? row.brandMentionRate : null,
        avgRank: row ? row.avgRank : null,
        citationShare: row ? row.citationShare : null,
        citationN: row ? Number(row.citationN ?? 0) : 0,
        lastError: row ? row.lastError : null,
      };
    }),
    leaderboard,
    alerts: listAlerts(db, { open: true, limit: 5 }),
    gap: gapRows,
    receipts: brandId === null ? [] : latestReceipts(db, brandId, { limit: 2, days, now }),
    nowMs: now.getTime(),
  };
}

/**
 * Scale raw daily counts into the 0..1 the sparkline plots, without inventing points
 * for days that had no run.
 * @param {{x: number, y: number}[]} points
 * @returns {{x: number, y: number}[]}
 */
function normaliseCounts(points) {
  const max = Math.max(1, ...points.map((point) => point.y));
  return points.map((point) => ({ x: point.x, y: point.y / max }));
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function kpiRow(view) {
  const k = view.kpi;
  // §6.6: only meaningful once an intent has more than one paraphrase.
  const spreadLine =
    k.phrasingSpread === null
      ? ''
      : html`<p class="kpi-sub muted">phrasing spread ± ${Math.round(k.phrasingSpread * 100)} pts</p>`;

  return html`<section class="kpi-row" aria-label="Headline numbers">
    <article class="card kpi">
      <h2>Share of AI voice</h2>
      <p class="kpi-value">${pct(k.sov.value)}</p>
      <p class="kpi-sub muted">${view.days}d · n=${k.answers.n} answers</p>
      ${deltaLine(k.sov.delta)}
      ${raw(sparkline({ points: k.sov.points, color: 'var(--s1)', title: 'Share of AI voice, by day' }))}
    </article>
    <article class="card kpi">
      <h2>Brand mention rate</h2>
      <p class="kpi-value">${rateWithCI(k.mentionRate.rate)}</p>
      <p class="kpi-sub muted">share of answers that name you</p>
      ${deltaLine(k.mentionRate.delta)}${spreadLine}
    </article>
    <article class="card kpi">
      <h2>Recommendation rate</h2>
      <p class="kpi-value">${rateWithCI(k.recRate.rate)}</p>
      <p class="kpi-sub muted">answers that put you forward as a pick</p>
      ${deltaLine(k.recRate.delta)}${spreadLine}
    </article>
    <article class="card kpi">
      <h2>Answers analysed</h2>
      <p class="kpi-value">${k.answers.n}</p>
      <p class="kpi-sub muted">${view.days}d · ${k.answers.spendCostStatus === 'known'
        ? `computed API usage ${usd(k.answers.spendUsd)}`
        : k.answers.spendCostStatus === 'partial'
          ? `computed API subtotal ${usd(k.answers.spendKnownSubtotalUsd)} plus unknown costs`
          : k.answers.spendAttemptedCalls === 0 ? 'no API calls recorded' : 'API usage cost unknown'}</p>
      ${raw(sparkline({ points: normaliseCounts(k.answers.points), color: 'var(--s1)', title: 'Answers per day' }))}
    </article>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function trendPanel(view) {
  const series = view.trend.series.filter((entry) => entry.points.length > 0);
  if (series.length === 0) {
    return html`<section class="card">
      <h2>Share of AI voice · ${view.days} days</h2>
      <p class="muted">
        No completed runs in this window, so there is nothing to plot. Days without runs stay gaps.
      </p>
    </section>`;
  }

  const legend = series.map((entry) => html`<span class="legend-item">${chip(entry.colorIndex)}<span>${entry.name}</span></span>`);

  const tableRows = view.trend.days.flatMap((day) =>
    day.series.map(
      (entry) => html`<tr>
        <td>${day.date}</td>
        <td>${view.trend.names.get(entry.entityId) ?? entry.entityId}</td>
        <td class="num">${pct(entry.sov, 1)}</td>
        <td class="num">${entry.n}</td>
      </tr>`,
    ),
  );

  return html`<section class="card">
    <h2>Share of AI voice · ${view.days} days</h2>
    <div class="legend">${legend}</div>
    <div class="chart-wrap">
      ${raw(
        lineChart({
          series,
          title: `Share of AI voice over ${view.days} days`,
          xFmt: (x) => new Date(x * 86400000).toISOString().slice(5, 10),
        }),
      )}
    </div>
    <p class="muted small">Days without a completed run are gaps, never zeros.</p>
    <details class="chart-table">
      <summary>View as table</summary>
      <table class="table">
        <thead>
          <tr>
            <th>Day (UTC)</th>
            <th>Entity</th>
            <th class="num">Share of voice</th>
            <th class="num">n</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </details>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function providerRow(view) {
  const cards = view.providers.map((provider) => {
    const rate = provider.brandMentionRate ? { ...provider.brandMentionRate, n: provider.n } : null;
    const status = !provider.enabled
      ? html`<p class="pstatus"><span aria-hidden="true">○</span> No API key · <a href="/settings">add one</a></p>`
      : provider.lastError
        ? html`<p class="pstatus is-error">
            <span aria-hidden="true">✖</span> Last error: ${truncate(provider.lastError, 60)}
          </p>`
        : html`<p class="pstatus is-ok"><span aria-hidden="true">●</span> Operational</p>`;

    return html`<article class="card pcard${provider.enabled ? '' : ' is-off'}">
      <h3>${provider.label}</h3>
      ${raw(
        meter({
          value: rate && typeof rate.p === 'number' ? rate.p : null,
          lo: rate && typeof rate.lo === 'number' ? rate.lo : null,
          hi: rate && typeof rate.hi === 'number' ? rate.hi : null,
          w: 140,
          title: `${provider.label} brand mention rate`,
        }),
      )}
      <p class="pcard-rate">${rateWithCI(rate)}</p>
      <dl class="kv kv-tight">
        <dt>Avg rank</dt>
        <dd>${num(provider.avgRank, 1)}</dd>
        ${provider.provider === 'perplexity'
          ? html`<dt>Citation share</dt>
              <dd>${rateWithCI({ p: provider.citationShare, n: provider.citationN })}</dd>`
          : ''}
      </dl>
      ${status}
    </article>`;
  });

  return html`<section aria-label="Engines">
    <h2 class="section-head">Engines</h2>
    <div class="pcard-row">${cards}</div>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function leaderboardPanel(view) {
  if (view.leaderboard.length === 0) {
    return html`<section class="card">
      <h2>Leaderboard</h2>
      <p class="muted">No mentions counted in the last ${view.days} days.</p>
    </section>`;
  }

  const rows = view.leaderboard
    .slice()
    .sort((a, b) => b.sov - a.sov)
    .map(
      (row) => html`<tr class="${row.isSelf ? 'is-brand' : ''}">
        <td>${chip(row.colorIndex)} ${row.name}${row.isSelf ? html` <span class="tag">you</span>` : ''}</td>
        <td class="num" data-sort="${row.sov}">
          <span
            class="sovbar"
            style="--sov:${(row.sov * 100).toFixed(2)}%; --sov-color:${esc(seriesColor(row.colorIndex))}"
            ><span class="sovbar-fill"></span
          ></span>
          ${pct(row.sov, 1)}
        </td>
        <td class="num" data-sort="${row.mentionRate?.p ?? -1}">${rateWithCI(row.mentionRate)}</td>
        <td class="num" data-sort="${row.avgRank ?? 99}">${num(row.avgRank, 1)}</td>
        <td class="num" data-sort="${row.recRate?.p ?? -1}">
          ${rateWithCI(row.recRate ? { p: row.recRate.p, n: row.recRate.n } : null)}
        </td>
        <td class="num" data-sort="${row.delta7d ?? 0}">
          ${row.delta7d === null
            ? html`<span class="muted">—</span>`
            : html`<span class="${row.delta7d > 0 ? 'is-up' : row.delta7d < 0 ? 'is-down' : 'muted'}"
                ><span aria-hidden="true">${row.delta7d > 0 ? '▲' : row.delta7d < 0 ? '▼' : ''}</span>
                ${Math.abs(Math.round(row.delta7d * 10) / 10)} pts</span
              >`}
        </td>
      </tr>`,
    );

  return html`<section class="card">
    <h2>Leaderboard</h2>
    <table class="table table-sortable">
      <thead>
        <tr>
          <th data-sortable>Entity</th>
          <th class="num" data-sortable>Share of voice</th>
          <th class="num" data-sortable>Mention rate</th>
          <th class="num" data-sortable>Avg rank</th>
          <th class="num" data-sortable>Rec. rate</th>
          <th class="num" data-sortable>Δ 7d</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function alertsPanel(view) {
  if (view.alerts.length === 0) {
    return html`<section class="card">
      <h2>Alerts</h2>
      <p class="muted">
        Nothing open. Alerts need two comparable prior runs, so a single noisy answer cannot raise one.
      </p>
    </section>`;
  }
  const items = view.alerts.map(
    (alert) => html`<li class="alert-row" data-alert-id="${alert.id}">
      ${severityChip(String(alert.severity))}
      <div class="alert-body">
        <p class="alert-title">${alert.title}</p>
        <p class="alert-detail muted">${alert.detail}</p>
      </div>
      <span class="alert-time muted">${relTime(String(alert.created_at), view.nowMs)}</span>
      <button type="button" class="btn btn-sm" data-ack="${alert.id}">Ack</button>
    </li>`,
  );
  return html`<section class="card">
    <h2>Alerts</h2>
    <ul class="alert-list">
      ${items}
    </ul>
    <p><a href="/alerts">All alerts →</a></p>
  </section>`;
}

/**
 * "Cited instead of you" (§11.3 #6) — hidden outright when there is no citation data,
 * rather than shown as an empty box.
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml|string}
 */
function citationGapPanel(view) {
  if (view.gap.length === 0) return '';
  const rows = view.gap.map((row) => ({ label: row.domain, value: Number(row.count ?? 0), color: 'var(--muted)' }));
  const links = view.gap.map(
    (row) => html`<li>
      <a href="/answers?days=${view.days}${row.topPromptId ? raw(`&amp;prompt_id=${Number(row.topPromptId)}`) : ''}"
        >${row.domain}</a
      >
      <span class="muted">${row.count} answers</span>
    </li>`,
  );
  return html`<section class="card">
    <h2>Cited instead of you</h2>
    <p class="muted">The shortlist of places to earn citations.</p>
    <div class="chart-wrap">
      ${raw(barChartH({ rows, w: 560, title: 'Domains cited in answers that never mention you' }))}
    </div>
    <ul class="gap-links">
      ${links}
    </ul>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml|string}
 */
function receiptsPanel(view) {
  if (view.receipts.length === 0) return '';
  const cards = view.receipts.map(
    (receipt) => html`<article class="card receipt">
      <p class="receipt-head">
        ${providerBadge(receipt.provider)}
        <span class="muted">${relTime(receipt.createdAt, view.nowMs)}</span>
        ${receipt.recommended === 1
          ? html`<span class="pill pill-good">recommended</span>`
          : html`<span class="pill">mentioned</span>`}
      </p>
      <p class="receipt-prompt">${truncate(receipt.prompt, 90)}</p>
      <p class="receipt-snippet">${receipt.snippet}</p>
      <p><a href="/answers?prompt_id=${receipt.promptId}&amp;provider=${receipt.provider}">See the full answer →</a></p>
    </article>`,
  );
  return html`<section aria-label="Latest receipts">
    <h2 class="section-head">Latest receipts</h2>
    <div class="receipt-row">${cards}</div>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  if (view.entityCount === 0) {
    const body = html`${emptyState({
      title: 'Nothing measured yet',
      line: 'Hearsay needs to know which brands to count before it can tell you anything.',
      hint: ctx.demo
        ? 'Demo mode is on: run node scripts/seed.js to load the fictional demo universe.'
        : 'Three steps: name your brand and competitors, add prompts, run the panel.',
      action: { href: '/setup', label: 'Start setup' },
    })}`;
    return layout({ title: 'Dashboard', active: '/', ctx, body });
  }

  const body = html`${kpiRow(view)}${trendPanel(view)}${providerRow(view)}${leaderboardPanel(view)}${alertsPanel(view)}${citationGapPanel(
    view,
  )}${receiptsPanel(view)}`;
  return layout({ title: 'Dashboard', active: '/', ctx, body });
}
