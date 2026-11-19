/**
 * BYOK DataForSEO plug-and-play adapter.
 *
 * Supports two explicit surfaces over DataForSEO v3 REST API (HTTP Basic auth):
 * - `'google-aio'`   POST https://api.dataforseo.com/v3/serp/google/organic/live/advanced
 * - `'chatgpt-web'`  POST https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced
 *
 * Secrets hygiene: credentials (`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`) travel in
 * the `Authorization: Basic ...` header only and are scrubbed before any error or log.
 */

import { config } from '../config.js';
import {
  ProviderError,
  billableAttempts,
  fetchWithRetry,
  normalizeCitations,
  scrubSecrets,
  usageNumber,
} from './shared.js';

/** @typedef {'google-aio'|'chatgpt-web'} DataForSeoMode */
/**
 * @typedef {import('./shared.js').ProviderResult & {
 *   mode: DataForSeoMode,
 *   locationControl: string,
 *   languageCode: string,
 *   costUsd: number|null,
 *   noAioPresent?: boolean,
 * }} DataForSeoResult
 */
/**
 * @typedef {Object} DataForSeoOptions
 * @property {DataForSeoMode|string} [mode]
 * @property {string} [model]
 * @property {string} [login]
 * @property {string} [password]
 * @property {string} [apiKey] optional `"login:password"` convenience fallback
 * @property {number|null} [locationCode]
 * @property {string|null} [languageCode]
 * @property {string} [device]
 * @property {boolean} [webSearch]
 * @property {number} [timeoutMs]
 * @property {number|null} [maxResponseBytes]
 * @property {AbortSignal} [signal]
 */
/**
 * @typedef {Object} DataForSeoHealthResult
 * @property {boolean} ok
 * @property {string} mode
 * @property {number|null} statusCode
 * @property {number} latencyMs
 * @property {number|null} costUsd
 * @property {string|null} error
 */

export const id = 'dataforseo';
export const GOOGLE_AIO_ENDPOINT = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';
export const CHATGPT_WEB_ENDPOINT = 'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced';
export const DEFAULT_LOCATION_CODE = 2840;
export const DEFAULT_LANGUAGE_CODE = 'en';
export const MODES = /** @type {const} */ (['google-aio', 'chatgpt-web']);

const EXCERPT_MAX_BYTES = 4096;

/** @param {unknown} value @returns {Record<string, unknown>|null} */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {string|null} */
function webUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {string|null} */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** @param {unknown} value @returns {string|null} */
function optionalExcerpt(value) {
  const text = optionalText(value);
  if (text === null) return null;
  if (Buffer.byteLength(text) <= EXCERPT_MAX_BYTES) return text;
  let end = Math.min(text.length, EXCERPT_MAX_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > EXCERPT_MAX_BYTES) {
    end -= 64;
  }
  return end > 0 ? text.slice(0, end).trim() : null;
}

/**
 * Scrub Basic auth tokens, raw credentials, and generic key patterns.
 * @param {string} text
 * @param {string} login
 * @param {string} password
 * @param {string} basicToken
 * @returns {string}
 */
function scrubCredentials(text, login, password, basicToken) {
  let out = scrubSecrets(String(text ?? '')).replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]');
  for (const secret of [basicToken, password, login]) {
    if (secret && secret.length >= 3) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/**
 * @param {DataForSeoOptions} opts
 * @returns {{login: string, password: string, basicToken: string}}
 */
function resolveCredentials(opts) {
  let login = String(opts.login ?? '').trim() || config.dataforseo.login;
  let password = String(opts.password ?? '').trim() || config.dataforseo.password;
  if ((!login || !password) && typeof opts.apiKey === 'string') {
    const sep = opts.apiKey.indexOf(':');
    if (sep > 0) {
      login = login || opts.apiKey.slice(0, sep).trim();
      password = password || opts.apiKey.slice(sep + 1).trim();
    }
  }
  if (!login || !password) {
    throw new ProviderError('auth', 'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set');
  }
  const basicToken = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  return { login, password, basicToken };
}

/**
 * @param {DataForSeoOptions} opts
 * @returns {DataForSeoMode}
 */
function resolveMode(opts) {
  const raw = opts.mode ?? (opts.model === 'chatgpt-web' || opts.model === 'dataforseo-chatgpt'
    ? 'chatgpt-web'
    : opts.model === 'google-aio' || opts.model === 'dataforseo-aio'
      ? 'google-aio'
      : 'google-aio');
  if (raw === 'google-aio' || raw === 'chatgpt-web') return raw;
  throw new RangeError(`Unsupported DataForSEO mode "${String(raw)}" (expected "google-aio" or "chatgpt-web")`);
}

/**
 * @param {DataForSeoOptions} opts
 * @returns {{locationCode: number, languageCode: string, locationControl: string}}
 */
function resolveGeo(opts) {
  const rawLoc = opts.locationCode ?? config.locationCode ?? DEFAULT_LOCATION_CODE;
  const locationCode = typeof rawLoc === 'number' ? rawLoc : Number(rawLoc);
  if (!Number.isInteger(locationCode) || locationCode <= 0) {
    throw new RangeError('DataForSEO locationCode must be a positive integer');
  }
  const rawLang = opts.languageCode ?? config.languageCode ?? DEFAULT_LANGUAGE_CODE;
  const languageCode = String(rawLang ?? '').trim() || DEFAULT_LANGUAGE_CODE;
  return { locationCode, languageCode, locationControl: `location_code:${locationCode}` };
}

/**
 * @param {number} code
 * @returns {import('./shared.js').ProviderErrorKind}
 */
function classifyDataForSeoStatus(code) {
  if (code === 40100 || code === 40101 || code === 40300) return 'auth';
  if ((code >= 40200 && code < 40300) || code === 42900) return 'quota';
  return 'other';
}

/**
 * @param {DataForSeoMode} mode
 * @param {string} text
 * @param {number} locationCode
 * @param {string} languageCode
 * @param {DataForSeoOptions} opts
 * @returns {{endpoint: string, body: unknown[]}}
 */
function buildRequest(mode, text, locationCode, languageCode, opts) {
  if (mode === 'google-aio') {
    return {
      endpoint: GOOGLE_AIO_ENDPOINT,
      body: [{
        keyword: text,
        location_code: locationCode,
        language_code: languageCode,
        load_async_ai_overview: true,
        expand_ai_overview: true,
        ...(opts.device ? { device: opts.device } : {}),
      }],
    };
  }
  return {
    endpoint: CHATGPT_WEB_ENDPOINT,
    body: [{
      prompt: text,
      location_code: locationCode,
      language_code: languageCode,
      web_search: opts.webSearch ?? true,
    }],
  };
}

/**
 * Extract readable text from an `ai_overview` SERP item.
 * @param {Record<string, unknown>} aio
 * @returns {string}
 */
function extractAioText(aio) {
  const md = optionalText(aio.markdown);
  if (md) return md;
  /** @type {string[]} */
  const parts = [];
  const topText = optionalText(aio.text);
  if (topText) parts.push(topText);
  if (Array.isArray(aio.items)) {
    for (const rawSub of aio.items) {
      const sub = asObject(rawSub);
      if (!sub) continue;
      const subBody = optionalText(sub.markdown) ?? optionalText(sub.text);
      const subTitle = optionalText(sub.title);
      const piece = subTitle && subBody && !subBody.startsWith(subTitle)
        ? `${subTitle}: ${subBody}`
        : subBody ?? subTitle;
      if (piece && !parts.some((existing) => existing.includes(piece))) {
        parts.push(piece);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Extract reference URLs from an `ai_overview` SERP item and its sub-items.
 * @param {Record<string, unknown>} aio
 * @returns {string[]}
 */
function extractAioReferenceUrls(aio) {
  /** @type {string[]} */
  const urls = [];
  const seen = new Set();
  /** @param {unknown} list */
  const collect = (list) => {
    if (!Array.isArray(list)) return;
    for (const rawRef of list) {
      const ref = asObject(rawRef);
      const url = typeof rawRef === 'string' ? webUrl(rawRef) : webUrl(ref?.url ?? ref?.link);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  };
  collect(aio.references);
  if (Array.isArray(aio.items)) {
    for (const rawSub of aio.items) {
      const sub = asObject(rawSub);
      if (sub) collect(sub.references);
    }
  }
  return urls;
}

/**
 * Parse DataForSEO Google Organic Live Advanced response for AI Overview + organic SERP sources.
 *
 * @param {Record<string, unknown>} task
 * @param {string} promptText
 * @param {number} latencyMs
 * @param {number|null} taskCost
 * @param {string} locationControl
 * @param {string} languageCode
 * @param {import('./shared.js').FetchResult} res
 * @returns {DataForSeoResult}
 */
function parseGoogleAio(task, promptText, latencyMs, taskCost, locationControl, languageCode, res) {
  const results = Array.isArray(task.result) ? task.result : [];
  const first = asObject(results[0]);
  const items = Array.isArray(first?.items) ? first.items : [];
  const actionId = `dataforseo:google-aio:${typeof task.id === 'string' && task.id ? task.id : '0'}`;
  const query = promptText.trim();
  /** @type {import('../measurement-contract.js').SearchAction[]} */
  const searchActions = [{
    id: actionId,
    kind: 'search',
    status: 'completed',
    queryMetadata: query ? 'available' : 'unavailable',
    queries: query ? [query] : [],
    observedAt: null,
    providerType: 'google_serp_aio',
  }];

  /** @type {import('../measurement-contract.js').SourceObservation[]} */
  const sources = [];
  /** @type {Map<string, string>} */
  const firstSourceByUrl = new Map();
  /** @type {Record<string, unknown>[]} */
  const aioItems = [];

  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) continue;
    if (item.type === 'ai_overview') {
      aioItems.push(item);
      continue;
    }
    if (item.type === 'organic') {
      const url = webUrl(item.url);
      if (!url) continue;
      const order = sources.length;
      const sourceId = `${actionId}:organic:${order}`;
      sources.push({
        id: sourceId,
        url,
        title: optionalText(item.title),
        excerpt: optionalExcerpt(item.description ?? item.snippet),
        provenance: 'search_result',
        actionId,
        order,
      });
      if (!firstSourceByUrl.has(url)) firstSourceByUrl.set(url, sourceId);
    }
  }

  if (aioItems.length === 0) {
    return {
      text: '',
      model: 'google-aio',
      mode: 'google-aio',
      latencyMs,
      answerStatus: 'empty',
      noAioPresent: true,
      searchActions,
      sources,
      answerCitations: [],
      citations: [],
      locationControl,
      languageCode,
      costUsd: taskCost,
      providerReportedChargeUsd: taskCost,
      billableAttempts: billableAttempts(res, null, null, 1),
    };
  }

  const aioText = aioItems.map(extractAioText).filter(Boolean).join('\n\n').trim();
  /** @type {import('../measurement-contract.js').AnswerCitation[]} */
  const answerCitations = [];
  const seenCitationUrls = new Set();
  for (const aio of aioItems) {
    for (const url of extractAioReferenceUrls(aio)) {
      if (seenCitationUrls.has(url)) continue;
      seenCitationUrls.add(url);
      answerCitations.push({
        url,
        provenance: 'native_annotation',
        sourceId: firstSourceByUrl.get(url) ?? null,
        start: null,
        end: null,
      });
    }
  }

  const hasText = aioText !== '';
  return {
    text: aioText,
    model: 'google-aio',
    mode: 'google-aio',
    latencyMs,
    answerStatus: hasText ? 'complete' : 'empty',
    noAioPresent: !hasText,
    searchActions,
    sources,
    answerCitations,
    citations: normalizeCitations(answerCitations),
    locationControl,
    languageCode,
    costUsd: taskCost,
    providerReportedChargeUsd: taskCost,
    billableAttempts: billableAttempts(res, null, null, 1),
  };
}

/**
 * Recursively extract readable text blocks from ChatGPT LLM Scraper `items[]`.
 * @param {unknown[]} items
 * @returns {string}
 */
function extractChatGptItemsText(items) {
  /** @type {string[]} */
  const parts = [];
  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) continue;
    const text = optionalText(item.markdown) ?? optionalText(item.text);
    if (text) parts.push(text);
    else if (Array.isArray(item.items)) {
      const nested = extractChatGptItemsText(item.items);
      if (nested) parts.push(nested);
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Collect deduplicated query strings from arbitrary string or string-array fields.
 * @param {unknown[]} candidates
 * @returns {string[]}
 */
function collectQueries(candidates) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    } else if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const text = typeof entry === 'string'
          ? entry.trim()
          : optionalText(asObject(entry)?.query) ?? optionalText(asObject(entry)?.text) ?? '';
        if (text && !seen.has(text)) {
          seen.add(text);
          out.push(text);
        }
      }
    }
  }
  return out;
}

/**
 * Parse DataForSEO ChatGPT LLM Scraper Live Advanced response.
 *
 * @param {Record<string, unknown>} task
 * @param {number} latencyMs
 * @param {number|null} taskCost
 * @param {string} locationControl
 * @param {string} languageCode
 * @param {import('./shared.js').FetchResult} res
 * @param {boolean} webSearchRequested
 * @returns {DataForSeoResult}
 */
function parseChatGptWeb(task, latencyMs, taskCost, locationControl, languageCode, res, webSearchRequested) {
  const results = Array.isArray(task.result) ? task.result : [];
  const payload = asObject(results[0]);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const actionId = `dataforseo:chatgpt-web:${typeof task.id === 'string' && task.id ? task.id : '0'}`;

  const answerText = optionalText(payload?.markdown)
    ?? optionalText(payload?.text)
    ?? extractChatGptItemsText(items);

  /** @type {unknown[]} */
  const queryCandidates = [
    payload?.fan_out_queries,
    payload?.search_queries,
    payload?.web_search_queries,
    payload?.queries,
  ];
  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) continue;
    queryCandidates.push(item.fan_out_queries, item.search_queries, item.queries, item.query);
  }
  const queries = collectQueries(queryCandidates);

  /** @type {import('../measurement-contract.js').SourceObservation[]} */
  const sources = [];
  /** @type {Map<string, string>} */
  const sourceIdByUrl = new Map();

  /** @param {unknown} list @param {'search_result'|'reported_source'} provenance @param {string} prefix */
  const addSources = (list, provenance, prefix) => {
    if (!Array.isArray(list)) return;
    for (const rawEntry of list) {
      const entry = asObject(rawEntry);
      const url = typeof rawEntry === 'string' ? webUrl(rawEntry) : webUrl(entry?.url ?? entry?.link);
      if (!url) continue;
      const order = sources.length;
      const sourceId = `${actionId}:${prefix}:${order}`;
      sources.push({
        id: sourceId,
        url,
        title: entry ? optionalText(entry.title ?? entry.source_name) : null,
        excerpt: entry ? optionalExcerpt(entry.description ?? entry.snippet) : null,
        provenance,
        actionId,
        order,
      });
      if (!sourceIdByUrl.has(url) || provenance === 'reported_source') {
        sourceIdByUrl.set(url, sourceId);
      }
    }
  };

  addSources(payload?.search_results, 'search_result', 'search');
  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (item) addSources(item.search_results, 'search_result', 'search');
  }

  addSources(payload?.sources, 'reported_source', 'source');
  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (item) addSources(item.sources, 'reported_source', 'source');
  }

  /** @type {import('../measurement-contract.js').AnswerCitation[]} */
  const answerCitations = [];
  const seenCitationUrls = new Set();
  /** @param {unknown} list */
  const addCitations = (list) => {
    if (!Array.isArray(list)) return;
    for (const rawEntry of list) {
      const entry = asObject(rawEntry);
      const url = typeof rawEntry === 'string' ? webUrl(rawEntry) : webUrl(entry?.url ?? entry?.link);
      if (!url || seenCitationUrls.has(url)) continue;
      seenCitationUrls.add(url);
      answerCitations.push({
        url,
        provenance: 'native_annotation',
        sourceId: sourceIdByUrl.get(url) ?? null,
        start: null,
        end: null,
      });
    }
  };

  addCitations(payload?.citations);
  addCitations(payload?.sources);
  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) continue;
    addCitations(item.citations);
    addCitations(item.sources);
    addCitations(item.annotations);
  }

  const observedSearch = queries.length > 0 || sources.length > 0 || answerCitations.length > 0 || webSearchRequested;
  /** @type {import('../measurement-contract.js').SearchAction[]} */
  const searchActions = observedSearch ? [{
    id: actionId,
    kind: 'search',
    status: 'completed',
    queryMetadata: queries.length > 0 ? 'available' : 'unavailable',
    queries,
    observedAt: null,
    providerType: 'chatgpt_web_search',
  }] : [];

  const model = optionalText(payload?.model) ?? 'chatgpt-web';
  return {
    text: answerText,
    model,
    mode: 'chatgpt-web',
    latencyMs,
    answerStatus: answerText !== '' ? 'complete' : 'empty',
    searchActions,
    sources,
    answerCitations,
    citations: normalizeCitations(answerCitations),
    locationControl,
    languageCode,
    costUsd: taskCost,
    providerReportedChargeUsd: taskCost,
    billableAttempts: billableAttempts(res, null, null, searchActions.length),
  };
}

/**
 * Run a prompt against DataForSEO (`'google-aio'` or `'chatgpt-web'`).
 *
 * @param {string} text
 * @param {DataForSeoOptions} [opts]
 * @returns {Promise<DataForSeoResult>}
 */
export async function runPrompt(text, opts = {}) {
  const mode = resolveMode(opts);
  const { locationCode, languageCode, locationControl } = resolveGeo(opts);
  const { login, password, basicToken } = resolveCredentials(opts);
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const maxResponseBytes = opts.maxResponseBytes ?? 4 * 1024 * 1024;
  const { endpoint, body } = buildRequest(mode, text, locationCode, languageCode, opts);

  const startedAt = Date.now();
  /** @type {import('./shared.js').FetchResult} */
  let res;
  try {
    res = await fetchWithRetry(
      endpoint,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basicToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs,
        signal: opts.signal,
        maxResponseBytes,
      },
    );
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ProviderError(
        err.kind,
        scrubCredentials(err.message, login, password, basicToken),
        scrubCredentials(err.detail, login, password, basicToken),
        err.billableAttempts,
      );
    }
    throw err;
  }
  const latencyMs = Date.now() - startedAt;

  const data = asObject(res.json);
  const attempts = billableAttempts(res, null, null, null);
  if (!data) {
    throw new ProviderError('other', 'Invalid DataForSEO response', 'expected JSON object', attempts);
  }
  const topStatus = typeof data.status_code === 'number' ? data.status_code : null;
  if (topStatus !== null && topStatus !== 20000) {
    const detail = scrubCredentials(String(data.status_message ?? ''), login, password, basicToken);
    throw new ProviderError(
      classifyDataForSeoStatus(topStatus),
      `DataForSEO error (${topStatus})`,
      detail,
      attempts,
    );
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = asObject(tasks[0]);
  if (!task) {
    throw new ProviderError('other', 'DataForSEO response had no tasks', 'unexpected response shape', attempts);
  }
  const taskCost = usageNumber(task.cost ?? data.cost);
  const taskStatus = typeof task.status_code === 'number' ? task.status_code : null;
  if (taskStatus !== null && taskStatus !== 20000) {
    // 40102 on Google SERP means "No Search Results" — treat cleanly as empty SERP / no AIO.
    if (mode === 'google-aio' && taskStatus === 40102) {
      return parseGoogleAio({ ...task, result: [] }, text, latencyMs, taskCost, locationControl, languageCode, res);
    }
    const detail = scrubCredentials(String(task.status_message ?? ''), login, password, basicToken);
    throw new ProviderError(
      classifyDataForSeoStatus(taskStatus),
      `DataForSEO task error (${taskStatus})`,
      detail,
      attempts,
    );
  }

  if (mode === 'google-aio') {
    return parseGoogleAio(task, text, latencyMs, taskCost, locationControl, languageCode, res);
  }
  return parseChatGptWeb(task, latencyMs, taskCost, locationControl, languageCode, res, opts.webSearch ?? true);
}

/**
 * Pre-wave health canary: sends a minimal 1-request probe with zero retries to verify
 * credentials, HTTP reachability, and DataForSEO response shape before committing a wave.
 *
 * @param {DataForSeoOptions & {probePrompt?: string}} [opts]
 * @returns {Promise<DataForSeoHealthResult>}
 */
export async function checkDataForSeoHealth(opts = {}) {
  const startedAt = Date.now();
  /** @type {DataForSeoMode} */
  let mode;
  try {
    mode = resolveMode(opts);
  } catch (err) {
    return {
      ok: false,
      mode: String(opts.mode ?? 'google-aio'),
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let geo;
  let creds;
  try {
    geo = resolveGeo(opts);
    creds = resolveCredentials(opts);
  } catch (err) {
    return {
      ok: false,
      mode,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const probePrompt = typeof opts.probePrompt === 'string' && opts.probePrompt.trim() !== ''
    ? opts.probePrompt.trim()
    : 'weather';
  const timeoutMs = opts.timeoutMs ?? Math.min(config.timeoutMs, 15000);
  const { endpoint, body } = buildRequest(mode, probePrompt, geo.locationCode, geo.languageCode, opts);

  try {
    const res = await fetchWithRetry(
      endpoint,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${creds.basicToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs,
        retries: 0,
        signal: opts.signal,
        maxResponseBytes: opts.maxResponseBytes ?? 4 * 1024 * 1024,
      },
    );
    const latencyMs = Date.now() - startedAt;
    const data = asObject(res.json);
    if (!data) {
      return { ok: false, mode, statusCode: res.status, latencyMs, costUsd: null, error: 'Invalid DataForSEO JSON response' };
    }
    const topStatus = typeof data.status_code === 'number' ? data.status_code : null;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const task = asObject(tasks[0]);
    const costUsd = usageNumber(task?.cost ?? data.cost);
    if (topStatus !== 20000) {
      const msg = scrubCredentials(String(data.status_message ?? `DataForSEO status ${topStatus}`),
        creds.login, creds.password, creds.basicToken);
      return { ok: false, mode, statusCode: topStatus ?? res.status, latencyMs, costUsd, error: msg };
    }
    if (!task) {
      return { ok: false, mode, statusCode: res.status, latencyMs, costUsd, error: 'DataForSEO response had no tasks' };
    }
    const taskStatus = typeof task.status_code === 'number' ? task.status_code : null;
    if (taskStatus !== 20000 && !(mode === 'google-aio' && taskStatus === 40102)) {
      const msg = scrubCredentials(String(task.status_message ?? `DataForSEO task status ${taskStatus}`),
        creds.login, creds.password, creds.basicToken);
      return { ok: false, mode, statusCode: taskStatus ?? res.status, latencyMs, costUsd, error: msg };
    }
    return { ok: true, mode, statusCode: res.status, latencyMs, costUsd, error: null };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const rawMsg = err instanceof ProviderError
      ? (err.detail ? `${err.message} — ${err.detail}` : err.message)
      : err instanceof Error ? err.message : String(err);
    const httpMatch = rawMsg.match(/HTTP\s+(\d{3})/);
    const statusCode = httpMatch ? Number(httpMatch[1]) : null;
    return {
      ok: false,
      mode,
      statusCode,
      latencyMs,
      costUsd: null,
      error: scrubCredentials(rawMsg, creds.login, creds.password, creds.basicToken),
    };
  }
}
