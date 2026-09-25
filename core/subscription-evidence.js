/** @typedef {import('./agent-parsers.js').SearchEvent} SearchEvent */
/** @typedef {import('./measurement-contract.js').SearchAction} SearchAction */
/** @typedef {import('./measurement-contract.js').SourceObservation} SourceObservation */

/**
 * Reconcile the start and terminal records already emitted by the CLI parsers.
 * An exposed provider ID takes priority. Without one, a terminal event can close the
 * oldest matching start; another terminal event remains a separate action.
 *
 * @param {SearchEvent[]} events
 * @returns {{actions:SearchAction[], sources:SourceObservation[]}}
 */
export function normalizeSubscriptionEvidence(events) {
  /** @type {SearchAction[]} */
  const actions = [];
  /** @type {SourceObservation[]} */
  const sources = [];
  /** @type {Map<string, SearchAction>} */
  const byProviderId = new Map();
  /** @type {Map<string, SearchAction[]>} */
  const pending = new Map();
  const sourceKeys = new Set();
  for (const event of events) {
    const queries = event.queries ?? (event.query === null ? [] : [event.query]);
    const key = `${event.eventType}:${event.eventType === 'search' ? queries[0] ?? '' : event.url ?? ''}`;
    /** @type {SearchAction|undefined} */
    let action = event.actionId ? byProviderId.get(`${event.eventType}:${event.actionId}`) : undefined;
    if (!action && !event.actionId && event.status !== 'started') {
      action = pending.get(key)?.shift();
      if (!action) {
        const unresolved = actions.filter((item) => item.kind === event.eventType && item.status === 'started');
        if (unresolved.length === 1 && (queries.length === 0 || unresolved[0].queries.length === 0)) {
          action = unresolved[0];
          for (const queue of pending.values()) {
            const index = queue.indexOf(action);
            if (index >= 0) queue.splice(index, 1);
          }
        }
      }
    }
    if (!action) {
      action = {
        id: event.actionId ? `${event.eventType}:${event.actionId}` : `local:${actions.length}`,
        kind: event.eventType,
        status: event.status,
        queryMetadata: queries.length === 0 ? 'unavailable' : 'available',
        queries: [...queries],
        observedAt: event.observedAt,
        providerType: event.providerEventType,
      };
      actions.push(action);
      if (event.actionId) byProviderId.set(action.id, action);
      if (!event.actionId && event.status === 'started') {
        const queue = pending.get(key) ?? [];
        queue.push(action);
        pending.set(key, queue);
      }
    } else {
      if (event.status !== 'started') action.status = event.status;
      for (const query of queries) if (!action.queries.includes(query)) action.queries.push(query);
      if (queries.length > 0) action.queryMetadata = 'available';
      action.observedAt ??= event.observedAt;
    }
    const results = event.results ?? (event.url === null ? [] : [{
      url: event.url, title: event.title, rank: event.rank,
    }]);
    for (const [ordinal, result] of results.entries()) {
      const order = event.results === undefined ? result.rank : result.rank ?? ordinal;
      const sourceKey = `${action.id}\u0000${order}\u0000${result.url}`;
      if (sourceKeys.has(sourceKey)) continue;
      sourceKeys.add(sourceKey);
      sources.push({
        id: `source:${sources.length}`, url: result.url, title: result.title,
        provenance: event.eventType === 'search' ? 'search_result' : 'fetch',
        actionId: action.id, order,
      });
    }
  }
  return { actions, sources };
}
