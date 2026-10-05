/**
 * Server-rendered SVG chart builders — PURE functions, no I/O, no Date.now (§11.7, §19.6 #6).
 *
 *   lineChart({series, w=720, h=220, yFmt})  — gaps: points >1 day apart are NOT connected
 *   barChartH({rows, w, h, xMax})            — 4px rounded data end, baseline-anchored
 *   sparkline({points, w=90, h=28, color})   — no axes, 2px line
 *   meter({value, lo, hi, w=160})            — 6px track, optional CI whisker
 *
 * Binding constraints (§11.7, §19.6 #2): at most 4 series, never a dual axis, gridlines
 * behind the marks, every `<svg>` carries `role="img"` and a `<title>`. Colours only ever
 * arrive as CSS custom-property references from the caller — this module invents none.
 */

import { esc } from './layout.js';

/** Hard cap on plotted series (§11.1). Extra series belong in a table, not the chart. */
export const MAX_SERIES = 4;

/**
 * @typedef {Object} Point
 * @property {number} x epoch day (days since 1970-01-01, UTC)
 * @property {number} y value in 0..1
 */

/**
 * @typedef {Object} Series
 * @property {string} name
 * @property {string} color CSS colour, normally `var(--s1)`…`var(--s4)`
 * @property {Point[]} points
 */

/**
 * Round for SVG output so coordinates stay short and stable.
 * @param {number} v
 * @returns {number}
 */
function r(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Percent formatter used when the caller supplies none.
 * @param {number} v 0..1
 * @returns {string}
 */
function pctFmt(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * Split a point list wherever the x gap exceeds one day: runs without data render as
 * gaps, never as interpolated continuity (§11.7, §19.6 #10).
 * @param {Point[]} points
 * @returns {Point[][]}
 */
export function splitGaps(points) {
  const sorted = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
  /** @type {Point[][]} */
  const runs = [];
  /** @type {Point[]} */
  let current = [];
  for (const p of sorted) {
    const prev = current[current.length - 1];
    if (prev && p.x - prev.x > 1) {
      runs.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * @param {Point[]} run
 * @param {(x: number) => number} sx
 * @param {(y: number) => number} sy
 * @returns {string}
 */
function path(run, sx, sy) {
  if (run.length === 1) {
    // A lone sample is a dot: a zero-length line would render nothing at all.
    return `M ${r(sx(run[0].x))} ${r(sy(run[0].y))} l 0.01 0`;
  }
  return run.map((p, i) => `${i === 0 ? 'M' : 'L'} ${r(sx(p.x))} ${r(sy(p.y))}`).join(' ');
}

/**
 * Trend line chart: y axis fixed to 0–100% with four gridlines above a baseline, direct
 * labels at the line ends, and a `data-chart` payload `public/app.js` turns into a shared
 * tooltip. Never a second y axis (§11.7).
 *
 * @param {Object} opts
 * @param {Series[]} opts.series
 * @param {number} [opts.w]
 * @param {number} [opts.h]
 * @param {(v: number) => string} [opts.yFmt]
 * @param {string} [opts.title] accessible name (`<title>`)
 * @param {(x: number) => string} [opts.xFmt] tick label for an epoch day
 * @returns {string}
 */
export function lineChart({ series, w = 720, h = 220, yFmt = pctFmt, title = 'Trend', xFmt }) {
  const plotted = series
    .slice(0, MAX_SERIES)
    .map((s) => ({ ...s, points: [...s.points].sort((a, b) => a.x - b.x) }));
  const all = plotted.flatMap((s) => s.points);
  const pad = { top: 12, right: 96, bottom: 24, left: 42 };
  const innerW = Math.max(1, w - pad.left - pad.right);
  const innerH = Math.max(1, h - pad.top - pad.bottom);

  if (all.length === 0) {
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${esc(title)} — no data</title><text class="chart-empty" x="${r(w / 2)}" y="${r(h / 2)}" text-anchor="middle">No data in this window</text></svg>`;
  }

  const xMin = Math.min(...all.map((p) => p.x));
  const xMaxRaw = Math.max(...all.map((p) => p.x));
  const xMax = xMaxRaw === xMin ? xMin + 1 : xMaxRaw;
  /** @param {number} x */
  const sx = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * innerW;
  /** @param {number} y */
  const sy = (y) => pad.top + (1 - Math.min(1, Math.max(0, y))) * innerH;

  // Gridlines first: they sit behind every mark (§11.7).
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = r(sy(t));
      const cls = t === 0 ? 'chart-baseline' : 'chart-grid';
      return `<line class="${cls}" x1="${pad.left}" y1="${y}" x2="${r(pad.left + innerW)}" y2="${y}"/><text class="axis-tick chart-axis" x="${pad.left - 6}" y="${r(y + 3.5)}" text-anchor="end">${esc(yFmt(t))}</text>`;
    })
    .join('');

  const xTicks = [xMin, xMax]
    .map((x, i) => {
      const label = xFmt ? xFmt(x) : '';
      if (label === '') return '';
      return `<text class="axis-tick chart-axis" x="${r(sx(x))}" y="${r(h - 8)}" text-anchor="${i === 0 ? 'start' : 'end'}">${esc(label)}</text>`;
    })
    .join('');

  const lines = plotted
    .map((s) =>
      splitGaps(s.points)
        .map((run) => `<path class="chart-line" d="${path(run, sx, sy)}" stroke="${esc(s.color)}"/>`)
        .join(''),
    )
    .join('');

  const endLabels = plotted
    .map((s) => {
      const last = s.points[s.points.length - 1];
      if (!last) return '';
      return `<text class="chart-endlabel" x="${r(sx(last.x) + 8)}" y="${r(sy(last.y) + 4)}">${esc(s.name)}</text>`;
    })
    .join('');

  // Tooltip payload: plain data only, read back by public/app.js.
  const payload = JSON.stringify({
    kind: 'line',
    plot: { left: r(pad.left), top: r(pad.top), width: r(innerW), height: r(innerH) },
    xMin,
    xMax,
    series: plotted.map((s) => ({ name: s.name, color: s.color, points: s.points.map((p) => [p.x, r(p.y)]) })),
  });

  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" data-chart="${esc(payload)}"><title>${esc(title)}</title>${grid}${xTicks}${lines}${endLabels}<line class="chart-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${r(pad.top + innerH)}" hidden="hidden"/></svg>`;
}

/**
 * Horizontal bars, baseline-anchored on the left, 4px rounded data end, 2px row gap.
 *
 * @param {Object} opts
 * @param {{label: string, value: number, color?: string}[]} opts.rows
 * @param {number} [opts.w]
 * @param {number} [opts.h] derived from the row count when omitted
 * @param {number} [opts.xMax]
 * @param {string} [opts.title]
 * @param {(v: number) => string} [opts.valueFmt]
 * @returns {string}
 */
export function barChartH({ rows, w = 560, h, xMax, title = 'Bars', valueFmt = (v) => String(v) }) {
  const rowH = 22;
  const gap = 2;
  if (rows.length === 0) {
    return `<svg class="chart" width="${w}" height="${rowH}" viewBox="0 0 ${w} ${rowH}" role="img"><title>${esc(title)} — no data</title><text class="chart-empty" x="0" y="15">No data</text></svg>`;
  }
  const height = h ?? rows.length * (rowH + gap);
  const labelW = Math.min(200, Math.round(w * 0.4));
  const valueW = 56;
  const trackW = Math.max(1, w - labelW - valueW - 12);
  const max = xMax ?? Math.max(...rows.map((row) => row.value), 1);
  const scale = max <= 0 ? 0 : trackW / max;

  const bars = rows
    .map((row, i) => {
      const y = i * (rowH + gap);
      const barH = rowH - 6;
      const len = row.value > 0 ? Math.max(2, r(row.value * scale)) : 0;
      const fill = row.color ?? 'var(--s1)';
      // Rounded data end only: the square cap keeps the baseline side flat (§11.7).
      const cap = len > 4 ? `<rect x="${labelW}" y="${r(y + 3)}" width="4" height="${barH}" fill="${esc(fill)}"/>` : '';
      return (
        `<text class="chart-barlabel" x="0" y="${r(y + rowH / 2 + 4)}">${esc(row.label)}</text>` +
        `<rect class="chart-bar" x="${labelW}" y="${r(y + 3)}" width="${len}" height="${barH}" rx="4" fill="${esc(fill)}"/>` +
        cap +
        `<text class="axis-tick chart-barvalue" x="${w}" y="${r(y + rowH / 2 + 4)}" text-anchor="end">${esc(valueFmt(row.value))}</text>`
      );
    })
    .join('');

  return `<svg class="chart" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img"><title>${esc(title)}</title><line class="chart-baseline" x1="${labelW}" y1="0" x2="${labelW}" y2="${height}"/>${bars}</svg>`;
}

/**
 * KPI sparkline — no axes, 2px line, same gap rule as `lineChart`.
 *
 * @param {Object} opts
 * @param {Point[]} opts.points
 * @param {number} [opts.w]
 * @param {number} [opts.h]
 * @param {string} [opts.color]
 * @param {string} [opts.title]
 * @returns {string}
 */
export function sparkline({ points, w = 90, h = 28, color = 'var(--s1)', title = 'Recent trend' }) {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length === 0) {
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${esc(title)} — no data</title></svg>`;
  }
  const xs = usable.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs) === xMin ? xMin + 1 : Math.max(...xs);
  const inset = 2;
  /** @param {number} x */
  const sx = (x) => inset + ((x - xMin) / (xMax - xMin)) * (w - inset * 2);
  /** @param {number} y */
  const sy = (y) => inset + (1 - Math.min(1, Math.max(0, y))) * (h - inset * 2);
  const paths = splitGaps(usable)
    .map((run) => `<path class="spark-line" d="${path(run, sx, sy)}" stroke="${esc(color)}"/>`)
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${esc(title)}</title>${paths}</svg>`;
}

/**
 * 6px meter with an optional confidence-interval whisker (§11.3 provider cards).
 *
 * @param {Object} opts
 * @param {number|null} opts.value 0..1, or null when there is nothing to show
 * @param {number|null} [opts.lo] interval low bound, 0..1
 * @param {number|null} [opts.hi] interval high bound, 0..1
 * @param {number} [opts.w]
 * @param {string} [opts.title]
 * @returns {string}
 */
export function meter({ value, lo, hi, w = 160, title = 'Rate' }) {
  const h = 12;
  const track = 6;
  const top = (h - track) / 2;
  /** @param {number} v */
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const parts = [`<rect class="meter-track" x="0" y="${top}" width="${w}" height="${track}" rx="3"/>`];
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    parts.push(`<rect class="meter-fill" x="0" y="${top}" width="${r(clamp(value) * w)}" height="${track}" rx="3"/>`);
  }
  if (typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi)) {
    const x1 = r(clamp(lo) * w);
    const x2 = r(clamp(hi) * w);
    parts.push(
      `<line class="meter-ci" x1="${x1}" y1="${r(h / 2)}" x2="${x2}" y2="${r(h / 2)}"/>` +
        `<line class="meter-ci" x1="${x1}" y1="1" x2="${x1}" y2="${h - 1}"/>` +
        `<line class="meter-ci" x1="${x2}" y1="1" x2="${x2}" y2="${h - 1}"/>`,
    );
  }
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const label = hasValue ? esc(title) : `${esc(title)} — no data`;
  return `<svg class="meter" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${label}</title>${parts.join('')}</svg>`;
}
