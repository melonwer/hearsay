/**
 * Entity highlighting for raw answer text (§11.4).
 *
 * `mentions` rows record only the *first* offset of each entity, so the spans are
 * recomputed for display with the analyser's own matcher — same word-boundary and
 * longest-alias-first rules, so what is underlined in the receipt is exactly what was
 * counted (§6.2). The analyser is pure, so this stays a render-time detail.
 */

import * as analyze from '../core/analyze.js';
import { esc, seriesSlot } from './layout.js';

/**
 * @param {string} text raw answer
 * @param {{id: number, name: string, aliases: string[], domains?: string[]}[]} entities
 * @param {Map<number, number>} colorIndex entity id → series slot index (§11.1)
 * @returns {string} escaped HTML with `<mark>` spans
 */
export function highlightAnswer(text, entities, colorIndex) {
  const body = typeof text === 'string' ? text : '';
  if (body === '') return '';
  const find = analyze.findAliasMatches;
  if (typeof find !== 'function' || !Array.isArray(entities) || entities.length === 0) return esc(body);

  /** @type {{entityId: number, start: number, end: number}[]} */
  let matches;
  try {
    matches = find(
      body,
      entities.map((e) => ({ id: e.id, name: e.name, aliases: e.aliases ?? [], domains: e.domains ?? [] })),
    );
  } catch {
    return esc(body);
  }

  /** @type {Map<number, string>} */
  const nameById = new Map(entities.map((e) => [e.id, e.name]));
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // defensive: spans are already non-overlapping
    out += esc(body.slice(cursor, match.start));
    const slot = seriesSlot(colorIndex.get(match.entityId) ?? 99);
    out += `<mark class="mk mk-${slot}" title="${esc(nameById.get(match.entityId) ?? '')}">${esc(
      body.slice(match.start, match.end),
    )}</mark>`;
    cursor = match.end;
  }
  out += esc(body.slice(cursor));
  return out;
}
