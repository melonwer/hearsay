/**
 * Server-rendered SVG chart builders — PURE functions, no I/O, no Date.now (§11.7, §19.6 #6).
 *
 * Phase 1 Lane C implements:
 *   lineChart({series, w=720, h=220, yFmt})  — gaps: points >1 day apart are NOT connected
 *   barChartH({rows, w, h, xMax})            — 4px rounded data end, baseline-anchored
 *   sparkline({points, w=90, h=28, color})   — no axes, 2px line
 *   meter({value, lo, hi, w=160})            — 6px track, optional CI whisker
 *
 * Binding constraints: max 4 series, no dual axes ever, gridlines behind marks,
 * every <svg> gets role="img" and a <title>.
 */
export {};
