/**
 * GET /entities — brand and competitor CRUD (§11.5).
 *
 * Exactly one entity is the brand (`is_self`), and it always holds series slot 1
 * (`--s1`). Competitors take the remaining slots in entity-id order, so a chart
 * colour follows the entity for the life of the install and never tracks its rank
 * (§11.1). The colour chip in each row is that promise, made visible.
 */

import { chip, emptyState, html, layout, raw, seriesSlot } from '../layout.js';
import { colorIndexFor, listEntities } from '../queries.js';

/**
 * @typedef {Object} EntitiesView
 * @property {import('../queries.js').Entity[]} entities archived rows included, brand first
 * @property {Map<number, number>} colorIndex entity id → series slot index (§11.1)
 * @property {number} activeCount entities that are not archived
 */

/**
 * @param {import('./dashboard.js').PageDeps} deps
 * @returns {EntitiesView}
 */
export function buildView({ db }) {
  const entities = listEntities(db, { includeArchived: true });
  return {
    entities,
    colorIndex: colorIndexFor(entities.filter((entity) => entity.archived_at === null)),
    activeCount: entities.filter((entity) => entity.archived_at === null).length,
  };
}

/**
 * @returns {import('../layout.js').RawHtml}
 */
function addForm() {
  return html`<section class="card">
    <h2>Add an entity</h2>
    <form class="inline-form" data-api-form="/api/entities" data-method="POST">
      <label class="grow">
        <span>Name</span>
        <input type="text" name="name" required placeholder="Competitor name" />
      </label>
      <label class="grow">
        <span>Aliases</span>
        <input type="text" name="aliases" data-list placeholder="comma, separated" />
      </label>
      <label class="grow">
        <span>Domains</span>
        <input type="text" name="domains" data-list placeholder="example.com" />
      </label>
      <label class="check">
        <input type="checkbox" name="is_self" data-bool />
        <span>This is my brand</span>
      </label>
      <label class="check">
        <input type="checkbox" name="ambiguous_name" data-bool />
        <span>Name may be an ordinary word</span>
      </label>
      <button type="submit" class="btn">Add entity</button>
    </form>
    <p class="muted small">
      Aliases shorter than three characters are rejected — they match too much text to be evidence of anything. A
      domain can belong to only one entity.
    </p>
    <p class="form-error" data-form-error hidden></p>
  </section>`;
}

/**
 * @param {ReturnType<typeof buildView>} view
 * @returns {import('../layout.js').RawHtml}
 */
function table(view) {
  const rows = view.entities.map((entity) => {
    const index = view.colorIndex.get(entity.id);
    return html`<tr class="${entity.archived_at === null ? '' : 'is-archived'}" data-entity-id="${entity.id}">
      <td>
        ${index === undefined ? '' : chip(index)} ${entity.name}
        ${entity.archived_at === null ? '' : html`<span class="tag">archived</span>`}
      </td>
      <td>
        ${entity.aliases.length === 0
          ? html`<span class="muted">none</span>`
          : entity.aliases.map((alias) => html`<span class="tag">${alias}</span> `)}
      </td>
      <td>
        ${entity.domains.length === 0
          ? html`<span class="muted">none</span>`
          : entity.domains.map((domain) => html`<code>${domain}</code> `)}
      </td>
      <td>
        <label class="check">
          <input
            type="radio"
            name="is_self"
            value="${entity.id}"
            data-entity-self="${entity.id}"
            ${entity.is_self === 1 ? raw('checked') : ''}
          />
          <span>brand</span>
        </label>
      </td>
      <td>
        <label class="check">
          <input type="checkbox" data-entity-ambiguous="${entity.id}"
            ${entity.ambiguous_name === 1 ? raw('checked') : ''} />
          <span>Review identity</span>
        </label>
      </td>
      <td class="num">
        <span class="muted small">${index === undefined ? '—' : seriesSlot(index)}</span>
      </td>
      <td class="num">
        <button type="button" class="btn btn-sm" data-entity-delete="${entity.id}">Delete</button>
      </td>
    </tr>`;
  });

  return html`<section class="card">
    <h2>Entities</h2>
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Aliases</th>
          <th>Domains</th>
          <th>Brand</th>
          <th>Name ambiguity</th>
          <th class="num">Colour</th>
          <th class="num"></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <p class="muted small">
      Deleting an entity that already has mentions archives it instead, so past answers keep their receipts.
    </p>
  </section>`;
}

/**
 * @param {import('../layout.js').ShellCtx} ctx
 * @param {ReturnType<typeof buildView>} view
 * @returns {string}
 */
export function render(ctx, view) {
  const body =
    view.entities.length === 0
      ? html`${addForm()}${emptyState({
          title: 'No entities yet',
          line: 'Hearsay counts mentions of the brands you name here — yours and your competitors.',
          hint: 'Exactly one entity is marked as your brand; it always keeps the same chart colour.',
          action: { href: '/setup', label: 'Add your brand' },
        })}`
      : html`${addForm()}${table(view)}`;

  return layout({ title: 'Entities', active: '/entities', ctx, body });
}
