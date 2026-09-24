/**
 * Bounded parsers for Codex JSONL and Claude Code stream-JSON.
 *
 * The parsers accept only structured provider events. They never execute event content,
 * treat page text as data, and keep search/fetch evidence separate from final citations.
 */

const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
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
 */

/** @typedef {{inputTokens:number|null, outputTokens:number|null}} AgentUsage */

/**
 * @typedef {Object} ParsedAgentOutput
 * @property {string|null} text
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
 * @param {{maxLineBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {Record<string, unknown>[]}
 */
function parseLines(input, options = {}) {
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
  return value === undefined || value === null ? null : String(value);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  const url = optionalString(input.url);
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
 * @param {string} input
 * @param {{maxLineBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {ParsedAgentOutput}
 */
export function parseCodexJsonl(input, options = {}) {
  const rawEvents = parseLines(input, options);
  /** @type {SearchEvent[]} */
  const searchEvents = [];
  let text = null;
  let errorCode = null;
  /** @type {AgentUsage} */
  let usage = { inputTokens: null, outputTokens: null };
  for (const event of rawEvents) {
    const eventType = String(event.type ?? '');
    const item = event.item && typeof event.item === 'object' ? /** @type {Record<string, unknown>} */ (event.item) : event;
    const itemType = String(item.type ?? '').toLowerCase();
    const action = item.action && typeof item.action === 'object' ? /** @type {Record<string, unknown>} */ (item.action) : item;
    if (itemType.includes('web_search') || itemType === 'websearch') {
      const rawStatus = item.status ?? action.status;
      const status = terminalSearchStatus(eventType, rawStatus);
      errorCode ??= terminalSearchErrorCode(rawStatus);
      const firstResult = Array.isArray(item.results) && item.results.length > 0 && item.results[0] && typeof item.results[0] === 'object'
        ? /** @type {Record<string, unknown>} */ (item.results[0])
        : {};
      const eventRow = evidence('search', status, {
        query: action.query ?? item.query,
        url: firstResult.url,
        title: firstResult.title,
        timestamp: event.timestamp,
      });
      eventRow.providerEventType = eventType;
      eventRow.actionId = optionalString(item.id ?? action.id);
      searchEvents.push(eventRow);
    } else if (itemType.includes('web_fetch') || itemType === 'webfetch') {
      const eventRow = evidence('fetch', eventType === 'item.completed' ? 'completed' : 'started', {
        url: action.url ?? item.url,
        timestamp: event.timestamp,
      });
      eventRow.providerEventType = eventType;
      eventRow.actionId = optionalString(item.id ?? action.id);
      searchEvents.push(eventRow);
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
  }
  return { text, searchEvents, citations: extractCitations(text), usage, webStatus: webStatus(searchEvents, text), errorCode, rawEvents };
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
 * @param {{maxLineBytes?:number, maxDepth?:number, maxEvents?:number}} [options]
 * @returns {ParsedAgentOutput}
 */
export function parseClaudeStreamJsonl(input, options = {}) {
  const rawEvents = parseLines(input, options);
  /** @type {SearchEvent[]} */
  const searchEvents = [];
  /** @type {Map<string, {eventIndex:number, eventType:'search'|'fetch', query:string|null, url:string|null}>} */
  const pending = new Map();
  let text = null;
  let errorCode = null;
  /** @type {AgentUsage} */
  let usage = { inputTokens: null, outputTokens: null };
  for (const event of rawEvents) {
    const message = event.message && typeof event.message === 'object' ? /** @type {Record<string, unknown>} */ (event.message) : null;
    if (String(event.type ?? '') === 'assistant' && message) {
      for (const item of contentItems(message.content)) {
        if (item.type === 'tool_use') {
          const name = String(item.name ?? '');
          const inputValue = item.input && typeof item.input === 'object' ? /** @type {Record<string, unknown>} */ (item.input) : {};
          if (name === 'WebSearch' || name === 'WebFetch') {
            const eventType = name === 'WebSearch' ? 'search' : 'fetch';
            const row = evidence(eventType, 'started', {
              query: inputValue.query,
              url: inputValue.url,
              timestamp: event.timestamp,
            });
            row.providerEventType = 'tool_use';
            row.actionId = optionalString(item.id);
            searchEvents.push(row);
            pending.set(String(item.id ?? ''), {
              eventIndex: searchEvents.length - 1,
              eventType,
              query: row.query,
              url: row.url,
            });
          }
        }
      }
    }
    if (String(event.type ?? '') === 'user') {
      const userMessage = event.message && typeof event.message === 'object' ? /** @type {Record<string, unknown>} */ (event.message) : {};
      for (const item of contentItems(userMessage.content)) {
        if (item.type !== 'tool_result') continue;
        const pendingEvent = pending.get(String(item.tool_use_id ?? ''));
        if (!pendingEvent) continue;
        const index = pendingEvent.eventIndex;
        const resultStatus = String(item.status ?? '').trim().toLowerCase();
        const failed = item.is_error === true
          || /(?:fail|error|quota|allowance|rate.?limit|throttl|limit|cancel|abort|timeout|unavailable|not.?available|denied|forbidden|permission)/.test(resultStatus);
        searchEvents[index].status = failed ? 'failed' : 'completed';
        if (failed) errorCode ??= terminalSearchErrorCode(resultStatus, item.is_error === true);
      }
    }
    if (String(event.type ?? '') === 'result') {
      if (typeof event.result === 'string') text = event.result;
      if (event.usage && typeof event.usage === 'object') {
        const resultUsage = /** @type {Record<string, unknown>} */ (event.usage);
        usage = {
          inputTokens: optionalNumber(resultUsage.input_tokens ?? resultUsage.inputTokens),
          outputTokens: optionalNumber(resultUsage.output_tokens ?? resultUsage.outputTokens),
        };
      }
    }
  }
  return { text, searchEvents, citations: extractCitations(text), usage, webStatus: webStatus(searchEvents, text), errorCode, rawEvents };
}
