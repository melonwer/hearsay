/**
 * GET /methodology — renders METHODOLOGY.md (§11.6).
 *
 * The renderer below covers exactly the subset the plan allows — h2/h3, paragraphs,
 * ul/ol, code, strong/em, links — and nothing else. That is not a limitation to work
 * around: it is what keeps a markdown library out of a zero-dependency project
 * (§19.6 #1). Anything unrecognised renders as literal escaped text.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esc, html, layout, raw } from '../layout.js';

const DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../METHODOLOGY.md');

/**
 * Inline markdown: code spans first (their contents are literal), then links, bold
 * and italics. Every fragment is escaped before any tag is added, so nothing in the
 * document can inject markup.
 *
 * @param {string} text
 * @returns {string} HTML
 */
export function renderInline(text) {
  /** @type {string[]} */
  const codes = [];
  // Park code spans behind a NUL-delimited placeholder: esc() leaves NUL alone
  // and no document text can contain one, so the round-trip is unambiguous.
  const parked = String(text).replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(String(code));
    return `\u0000${codes.length - 1}\u0000`;
  });

  let out = esc(parked);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => {
    const safe = String(href).replace(/"/g, '&quot;');
    return `<a href="${safe}" rel="noreferrer noopener">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${esc(codes[Number(index)])}</code>`);
  return out;
}

/**
 * Block-level markdown subset: `##`/`###` headings, `-`/`*` bullet lists, `1.` ordered
 * lists, fenced code blocks, and paragraphs. `#` is dropped — the page already has an
 * h1 from the shell.
 *
 * @param {string} markdown
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let paragraph = [];
  /** @type {string[]} */
  let list = [];
  /** @type {'ul'|'ol'|null} */
  let listKind = null;
  /** @type {string[]|null} */
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listKind === null) return;
    out.push(`<${listKind}>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${listKind}>`);
    list = [];
    listKind = null;
  };

  for (const line of lines) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      fence = [];
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      // The shell already renders an h1, so a document h1 becomes an h2.
      const level = Math.max(2, heading[1].length);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listKind !== null && listKind !== 'ul') flushList();
      listKind = 'ul';
      list.push(bullet[1]);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listKind !== null && listKind !== 'ol') flushList();
      listKind = 'ol';
      list.push(ordered[1]);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    if (listKind !== null) {
      // A wrapped continuation of the previous list item.
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }

  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join('\n');
}

/**
 * @typedef {Object} MethodologyView
 * @property {string} markdown raw METHODOLOGY.md source, empty when it is missing
 * @property {boolean} missing the document is not in this checkout
 */

/**
 * @param {import('./dashboard.js').PageDeps} [deps]
 * @param {{path?: string}} [opts]
 * @returns {MethodologyView}
 */
export function buildView(deps, opts = {}) {
  const path = opts.path ?? DOC_PATH;
  try {
    return { markdown: readFileSync(path, 'utf8'), missing: false };
  } catch {
    return { markdown: '', missing: true };
  }
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const body = view.missing
    ? html`<section class="card">
        <h2>Methodology</h2>
        <p class="muted">METHODOLOGY.md is not in this checkout, so there is nothing to render.</p>
      </section>`
    : html`<article class="card prose">${raw(renderMarkdown(view.markdown))}</article>`;
  return layout({ title: 'Methodology', active: '/methodology', ctx, body });
}
