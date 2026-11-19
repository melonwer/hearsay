/**
 * Bounded parsers for Codex JSONL and Claude Code stream-JSON.
 *
 * The parsers accept only structured provider events. They never execute event content,
 * treat page text as data, and keep search/fetch evidence separate from final citations.
 */

const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_EVENTS = 10_000;

export class AgentParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AgentParseError';
  }
}

/** @typedef {'started'|'completed'|'failed'|'denied'|'unavailable'} EvidenceStatus */

/**
 * @typedef {Object} SearchEvent
 * @property {'search'|'fetch'} eventType
 * @property {EvidenceStatus} status
 * @property {string|null} query
 * @property {string|null} url
 * @property {string|null} title
 * @property {string|null} domain
 * @property {string|null} observedAt
 * @property {number|null} rank
 * @property {string|null} providerEventType
 * @property {string|null} actionId
 * @property {string[]} [queries]
 * @property {{url:string,title:string|null,rank:number|null}[]} [results]
 */

/** @typedef {{inputTokens:number|null, outputTokens:number|null}} AgentUsage */

/**
 * @typedef {Object} ParsedAgentOutput
 * @property {string|null} text
 * @property {string|null} [model]
 * @property {SearchEvent[]} searchEvents
 * @property {string[]} citations
 * @property {AgentUsage} usage
 * @property {'verified'|'unavailable'|'unverified'|'failed'} webStatus
 * @property {string|null} errorCode
 * @property {Record<string, unknown>[]} rawEvents
 */

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {void}
 */
function assertDepth(value, depth, maxDepth) {
  if (depth > maxDepth) throw new AgentParseError('event nesting depth limit exceeded');
  if (Array.isArray(value)) {
    for (const item of value) assertDepth(item, depth + 1, maxDepth);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertDepth(item, depth + 1, maxDepth);
  }
}

/**
 * @param {string} input
 * @param {{maxLineBytes?:number, maxOutputBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {Record<string, unknown>[]}
 */
export function parseLines(input, options = {}) {
  if (Buffer.byteLength(input) > (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
    throw new AgentParseError('event output limit exceeded');
  }
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const events = [];
  for (const line of String(input).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line) > maxLineBytes) throw new AgentParseError('event line limit exceeded');
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AgentParseError('malformed event JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentParseError('event must be a JSON object');
    assertDepth(parsed, 0, maxDepth);
    events.push(/** @type {Record<string, unknown>} */ (parsed));
    if (events.length > maxEvents) throw new AgentParseError('event count limit exceeded');
  }
  return events;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** @param {unknown} value @returns {string|null} */
function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {...unknown} values @returns {string[]} */
function exposedQueries(...values) {
  /** @type {string[]} */
  const queries = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item.trim() !== '' && !queries.includes(item)) queries.push(item);
    }
  }
  if (queries.length > 200) throw new AgentParseError('search query count limit exceeded');
  return queries;
}

/** @param {unknown} value @returns {{url:string,title:string|null,rank:number|null}[]} */
function exposedResults(value) {
  /** @type {unknown[]} */
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  /** @type {{url:string,title:string|null,rank:number|null}[]} */
  const results = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string,unknown>} */ (item);
    if (httpUrl(row.url) !== null) {
      results.push({ url: /** @type {string} */ (row.url), title: optionalString(row.title), rank: optionalNumber(row.rank ?? row.ordinal) });
    }
    if (Array.isArray(row.results)) {
      results.push(...exposedResults(row.results));
    } else if (Array.isArray(row.content)) {
      results.push(...exposedResults(row.content));
    }
    if (results.length > 400) throw new AgentParseError('search result count limit exceeded');
  }
  return results;
}

/** @param {string|null} text @returns {string[]} */
function extractCitations(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\)\]}]+/gi)) {
    const url = String(match[0]).replace(/[.,!?;:]+$/, '');
    if (url !== '' && !seen.has(url)) {
      seen.add(url);
      found.push(url);
    }
  }
  return found;
}

/**
 * @param {string} eventType
 * @param {EvidenceStatus} status
 * @param {{query?:unknown, url?:unknown, title?:unknown, rank?:unknown, timestamp?:unknown}} [input]
 * @returns {SearchEvent}
 */
function evidence(eventType, status, input = {}) {
  const url = httpUrl(input.url);
  let domain = null;
  if (url) {
    try {
      domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      domain = null;
    }
  }
  return {
    eventType: /** @type {'search'|'fetch'} */ (eventType),
    status,
    query: optionalString(input.query),
    url,
    title: optionalString(input.title),
    domain,
    observedAt: optionalString(input.timestamp),
    rank: optionalNumber(input.rank),
    providerEventType: null,
    actionId: null,
  };
}

/** @param {SearchEvent[]} events @param {string|null} text @returns {ParsedAgentOutput['webStatus']} */
function webStatus(events, text) {
  if (events.some((event) => event.eventType === 'search' && event.status === 'completed')) return 'verified';
  if (events.some((event) => event.eventType === 'search' && (event.status === 'failed' || event.status === 'denied'))) return 'failed';
  if (events.some((event) => event.eventType === 'search' && event.status === 'started')) return text ? 'unverified' : 'failed';
  return text ? 'unverified' : 'unavailable';
}

/**
 * Provider event streams can report a terminal event whose status is not success.
 * Preserve that distinction so rate limits, denials, cancellations, and outages never
 * become verified search evidence merely because the provider emitted a completion event.
 *
 * @param {string} eventType
 * @param {unknown} rawStatus
 * @returns {EvidenceStatus}
 */
function terminalSearchStatus(eventType, rawStatus) {
  const status = String(rawStatus ?? '').trim().toLowerCase();
  if (/(?:denied|forbidden|permission)/.test(status)) return 'denied';
  if (eventType === 'item.failed') return 'failed';
  if (/(?:fail|error|quota|allowance|rate.?limit|throttl|limit|cancel|abort|timeout|unavailable|not.?available)/.test(status)) {
    return 'failed';
  }
  if (eventType === 'item.completed' && (status === '' || /^(?:complete|completed|success|succeeded|ok)$/.test(status))) {
    return 'completed';
  }
  return 'started';
}

/**
 * @param {unknown} rawStatus
 * @param {boolean} [isError]
 * @returns {string|null}
 */
function terminalSearchErrorCode(rawStatus, isError = false) {
  const status = String(rawStatus ?? '').trim().toLowerCase();
  if (/(?:quota|allowance)/.test(status)) return 'quota_exhausted';
  if (/(?:rate.?limit|throttl|\blimit\b)/.test(status)) return 'rate_limited';
  if (/(?:denied|forbidden|permission)/.test(status)) return 'web_search_denied';
  if (isError || /(?:fail|error|cancel|abort|timeout|unavailable|not.?available)/.test(status)) return 'web_search_failed';
  return null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function observedModel(value) {
  const text = optionalString(value);
  if (text === null || /^<[^>]+>$/.test(text)) return null;
  return text;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string|null}
 */
function claudeEventErrorCode(event) {
  const type = String(event.type ?? '');
  if (type === 'rate_limit_event') {
    const info = event.rate_limit_info && typeof event.rate_limit_info === 'object'
      ? /** @type {Record<string, unknown>} */ (event.rate_limit_info) : null;
    if (!info) return null;
    const status = String(info.status ?? '').toLowerCase();
    const code = String(info.errorCode ?? info.error_code ?? '').toLowerCase();
    if (status !== 'rejected' && code === '') return null;
    if (/(?:credit|quota|allowance|overage|usage.?limit|exhausted)/.test(`${code} ${status}`)) return 'quota_exhausted';
    return 'rate_limited';
  }
  const diag = [
    event.api_error_code,
    event.api_error,
    event.api_error_type,
    event.error,
    event.terminal_reason,
    typeof event.result === 'string' ? event.result : null,
  ].filter((part) => typeof part === 'string' && part.trim() !== '').join(' ').toLowerCase();
  const status = optionalNumber(event.api_error_status);
  if (status === 401 || status === 403 || /(?:unauthenticated|authentication|login|credential)/.test(diag)) {
    return 'authentication_failed';
  }
  if (/(?:credits?_required|usage.?credits?|model_requires_usage_credits|quota|allowance|usage.?limit|resource.?exhausted)/.test(diag)) {
    return 'quota_exhausted';
  }
  if (status === 429 || /(?:rate.?limit|throttl)/.test(diag)) return 'rate_limited';
  return 'agent_failed';
}

/**
 * @param {SearchEvent[]} searchEvents
 * @param {Map<string, number>} byActionId
 * @param {SearchEvent} eventRow
 * @returns {void}
 */
function upsertCodexSearchEvent(searchEvents, byActionId, eventRow) {
  if (eventRow.actionId !== null && byActionId.has(eventRow.actionId)) {
    const existing = searchEvents[/** @type {number} */ (byActionId.get(eventRow.actionId))];
    if (existing.status === 'started' && eventRow.status !== 'started') {
      existing.eventType = eventRow.eventType;
      existing.status = eventRow.status;
      existing.providerEventType = eventRow.providerEventType;
    } else if (existing.status === eventRow.status && eventRow.eventType !== existing.eventType && existing.queries?.length === 0 && existing.url === null) {
      existing.eventType = eventRow.eventType;
    }
    if (eventRow.url) {
      existing.url = eventRow.url;
      existing.domain = eventRow.domain;
    }
    if (eventRow.title) existing.title = eventRow.title;
    existing.observedAt ??= eventRow.observedAt;
    const mergedQueries = [...(existing.queries ?? [])];
    for (const query of eventRow.queries ?? []) {
      if (!mergedQueries.includes(query)) mergedQueries.push(query);
    }
    if (mergedQueries.length > 0 || existing.queries) {
      existing.queries = mergedQueries;
      existing.query = mergedQueries[0] ?? existing.query ?? null;
    }
    if (eventRow.results && eventRow.results.length > 0) {
      existing.results ??= [];
      const seen = new Set(existing.results.map((item) => `${item.url}\u0000${item.rank ?? ''}`));
      for (const item of eventRow.results) {
        const key = `${item.url}\u0000${item.rank ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          existing.results.push(item);
        }
      }
    }
    return;
  }
  if (eventRow.actionId !== null) byActionId.set(eventRow.actionId, searchEvents.length);
  searchEvents.push(eventRow);
}

/**
 * @param {string} input
 * @param {{maxLineBytes?:number, maxOutputBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {ParsedAgentOutput}
 */
export function parseCodexJsonl(input, options = {}) {
  const rawEvents = parseLines(input, options);
  /** @type {SearchEvent[]} */
  const searchEvents = [];
  /** @type {Map<string, number>} */
  const byActionId = new Map();
  let text = null;
  let model = null;
  let errorCode = null;
  /** @type {AgentUsage} */
  let usage = { inputTokens: null, outputTokens: null };
  for (const event of rawEvents) {
    const eventType = String(event.type ?? '');
    const item = event.item && typeof event.item === 'object' ? /** @type {Record<string, unknown>} */ (event.item) : event;
    const itemType = String(item.type ?? '').toLowerCase();
    const action = item.action && typeof item.action === 'object' ? /** @type {Record<string, unknown>} */ (item.action) : item;
    model = observedModel(event.model ?? item.model) ?? model;
    const searchAction = String(action.type ?? '');
    if (itemType === 'web_search_call' || itemType === 'websearch' || itemType === 'web_search' && (searchAction === 'search' || searchAction === 'other' || searchAction === '')) {
      const rawStatus = item.status ?? action.status;
      const status = itemType === 'web_search' && searchAction !== 'search' && eventType === 'item.completed'
        ? 'unavailable' : terminalSearchStatus(eventType, rawStatus);
      errorCode ??= terminalSearchErrorCode(rawStatus, eventType === 'item.failed');
      const queries = exposedQueries(action.query, action.queries);
      if (!queries.length) queries.push(...exposedQueries(item.query, item.queries));
      const results = exposedResults(item.results ?? action.results);
      const eventRow = evidence('search', status, {
        query: queries[0],
        timestamp: event.timestamp,
      });
      eventRow.queries = queries;
      eventRow.results = results;
      eventRow.providerEventType = eventType;
      eventRow.actionId = optionalString(item.id ?? action.id);
      upsertCodexSearchEvent(searchEvents, byActionId, eventRow);
    } else if (itemType === 'web_fetch_call' || itemType === 'webfetch' || itemType === 'web_search' && ['open', 'find', 'open_page', 'find_in_page'].includes(searchAction)) {
      const rawStatus = item.status ?? action.status;
      const results = exposedResults(item.results ?? action.results);
      const url = httpUrl(action.url ?? item.url);
      const title = optionalString(action.title ?? item.title) ?? results.find((entry) => entry.url === url)?.title ?? null;
      const eventRow = evidence('fetch', terminalSearchStatus(eventType, rawStatus), {
        url,
        title,
        timestamp: event.timestamp,
      });
      errorCode ??= terminalSearchErrorCode(rawStatus, eventType === 'item.failed');
      eventRow.results = results;
      eventRow.providerEventType = eventType;
      eventRow.actionId = optionalString(item.id ?? action.id);
      upsertCodexSearchEvent(searchEvents, byActionId, eventRow);
    } else if (itemType === 'agent_message' || itemType === 'agentmessage') {
      const message = item.text ?? item.content;
      if (typeof message === 'string') text = message;
    }
    if (eventType === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      const turnUsage = /** @type {Record<string, unknown>} */ (event.usage);
      usage = {
        inputTokens: optionalNumber(turnUsage.input_tokens ?? turnUsage.inputTokens),
        outputTokens: optionalNumber(turnUsage.output_tokens ?? turnUsage.outputTokens),
      };
    }
    if (eventType === 'turn.failed') errorCode ??= 'agent_failed';
  }
  return { text, model, searchEvents, citations: extractCitations(text), usage, webStatus: webStatus(searchEvents, text), errorCode, rawEvents };
}

/**
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function contentItems(content) {
  if (Array.isArray(content)) return content.filter((item) => item && typeof item === 'object').map((item) => /** @type {Record<string, unknown>} */ (item));
  return content && typeof content === 'object' ? [/** @type {Record<string, unknown>} */ (content)] : [];
}

/**
 * @param {string} input
 * @param {{maxLineBytes?:number, maxOutputBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {ParsedAgentOutput}
 */
export function parseClaudeStreamJsonl(input, options = {}) {
  const rawEvents = parseLines(input, options);
  /** @type {SearchEvent[]} */
  const searchEvents = [];
  /** @type {Map<string, number>} */
  const pending = new Map();
  let text = null;
  let model = null;
  let errorCode = null;
  /** @type {AgentUsage} */
  let usage = { inputTokens: null, outputTokens: null };
  for (const event of rawEvents) {
    const type = String(event.type ?? '');
    const message = event.message && typeof event.message === 'object' ? /** @type {Record<string, unknown>} */ (event.message) : null;
    const isApiErrorAssistant = type === 'assistant' && (event.is_api_error_message === true || (typeof event.error === 'string' && event.error !== ''));
    if (!isApiErrorAssistant) model = observedModel(message?.model ?? event.model) ?? model;
    if (type === 'rate_limit_event') {
      const rateLimitError = claudeEventErrorCode(event);
      if (rateLimitError) errorCode ??= rateLimitError;
    }
    if (type === 'assistant' && message) {
      if (isApiErrorAssistant) {
        errorCode ??= claudeEventErrorCode(event) ?? 'agent_failed';
        continue;
      }
      const chunks = contentItems(message.content).filter((item) => item.type === 'text' && typeof item.text === 'string');
      if (chunks.length) text = chunks.map((item) => item.text).join('\n');
      for (const item of contentItems(message.content)) {
        if (item.type === 'tool_use') {
          const name = String(item.name ?? '');
          const inputValue = item.input && typeof item.input === 'object' ? /** @type {Record<string, unknown>} */ (item.input) : {};
          if (name === 'WebSearch' || name === 'WebFetch') {
            const eventType = name === 'WebSearch' ? 'search' : 'fetch';
            const queries = exposedQueries(inputValue.query, inputValue.queries);
            const row = evidence(eventType, 'started', {
              query: queries[0],
              url: inputValue.url,
              timestamp: event.timestamp,
            });
            row.queries = queries;
            row.providerEventType = 'tool_use';
            row.actionId = optionalString(item.id);
            searchEvents.push(row);
            if (row.actionId !== null) pending.set(row.actionId, searchEvents.length - 1);
          }
        }
      }
    }
    if (type === 'user') {
      const userMessage = event.message && typeof event.message === 'object' ? /** @type {Record<string, unknown>} */ (event.message) : {};
      for (const item of contentItems(userMessage.content)) {
        if (item.type !== 'tool_result') continue;
        const toolId = optionalString(item.tool_use_id);
        if (toolId === null) continue;
        const index = pending.get(toolId);
        if (index === undefined) continue;
        pending.delete(toolId);
        const resultStatus = String(item.status ?? '').trim().toLowerCase();
        const failed = item.is_error === true
          || /(?:fail|error|quota|allowance|rate.?limit|throttl|limit|cancel|abort|timeout|unavailable|not.?available|denied|forbidden|permission)/.test(resultStatus);
        searchEvents[index].status = failed
          ? terminalSearchStatus('item.completed', item.status ?? (item.is_error === true ? 'failed' : null))
          : 'completed';
        if (failed && searchEvents[index].status === 'started') searchEvents[index].status = 'failed';
        if (!failed && searchEvents[index].eventType === 'search') {
          searchEvents[index].results = exposedResults(item.content ?? item.results);
        }
        if (failed) errorCode ??= terminalSearchErrorCode(resultStatus, item.is_error === true);
      }
    }
    if (type === 'result') {
      const resultFailed = event.is_error === true
        || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
        || event.terminal_reason === 'api_error';
      if (resultFailed) {
        const classified = claudeEventErrorCode(event);
        errorCode = errorCode && errorCode !== 'agent_failed' ? errorCode : (classified ?? 'agent_failed');
      } else if (typeof event.result === 'string') {
        text = event.result;
      }
      if (event.usage && typeof event.usage === 'object') {
        const resultUsage = /** @type {Record<string, unknown>} */ (event.usage);
        usage = {
          inputTokens: optionalNumber(resultUsage.input_tokens ?? resultUsage.inputTokens),
          outputTokens: optionalNumber(resultUsage.output_tokens ?? resultUsage.outputTokens),
        };
      }
    }
  }
  return { text, model, searchEvents, citations: extractCitations(text), usage, webStatus: webStatus(searchEvents, text), errorCode, rawEvents };
}
