import { html } from './layout.js';

/** @typedef {ReturnType<typeof import('../core/providers/gemini-grounding.js').parseGeminiGrounding>['receipt']} Receipt */

/**
 * Keep Google's HTML in an opaque-origin frame. The frame cannot run scripts,
 * submit forms, or access Hearsay's document and storage.
 * @param {Receipt|null} receipt
 */
export function searchSuggestions(receipt) {
  if (!receipt || receipt.status !== 'present') return '';
  const entry = receipt.searchEntryPoint;
  const fields = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? /** @type {Record<string, unknown>} */ (entry) : null;
  const markup = typeof fields?.renderedContent === 'string' ? fields.renderedContent : null;
  if (!markup?.trim()) return html`<p class="muted">Search Suggestions were not supplied for this response.</p>`;
  return html`<section class="gemini-suggestions" aria-label="Google Search Suggestions">
    <h4>Google Search Suggestions</h4>
    <iframe title="Google Search Suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer" srcdoc="${markup}"></iframe>
  </section>`;
}

/** @param {Receipt|null} receipt */
export function originalGrounding(receipt) {
  if (!receipt) return '';
  return html`<details class="gemini-grounding-original">
    <summary>Original Gemini grounding metadata (${receipt.status})</summary>
    <pre>${JSON.stringify(receipt, null, 2)}</pre>
  </details>`;
}
