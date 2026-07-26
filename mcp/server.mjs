#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server (§13, SPEC §2/§6). Newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; logs go to stderr. Data comes from a running
 * Hearsay over HTTP at HEARSAY_URL — this process holds no API keys and opens no DB.
 */
import { readFileSync } from 'node:fs';

const HEARSAY_URL = (process.env.HEARSAY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
// [VERIFY-AT-BUILD]: verified 2026-07-26 against modelcontextprotocol.io/specification/versioning
// — current revision is 2025-11-25; earlier revisions remain valid to echo.
const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DAYS = { type: 'integer', minimum: 1, maximum: 365, description: 'Reporting window in days (default 30)' };
const ENTITY_FIELDS = {
  name: { type: 'string', description: 'Entity name, e.g. "Acme"' },
  aliases: { type: 'array', items: { type: 'string' }, description: 'Other names it goes by (≥3 chars each)' },
  domains: { type: 'array', items: { type: 'string' }, description: 'Domains it owns, e.g. "acme.com"' },
};
/** @param {Record<string, unknown>} properties @param {string[]} [required] */
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
/** @param {Record<string, any>} args @param {string[]} keys @param {Record<string,string>} [rename] */
function query(args, keys, rename = {}) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null) params.set(rename[key] ?? key, String(value));
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {boolean} [readOnly]
 * @property {string} description
 * @property {object} inputSchema
 * @property {(args: Record<string, any>) => {method: string, path: string, body?: unknown}} call
 */

/** @type {Tool[]} */
const TOOLS = [
  {
    name: 'hearsay_status',
    readOnly: true,
    description:
      'Check whether the local Hearsay AI-visibility tracker is running and configured: enabled providers (ChatGPT, Claude, Gemini, Perplexity), tracked brand/competitor/prompt counts, last measurement run, schedule, 30-day API spend. Call this FIRST for any AI visibility / GEO / AI SEO / brand-monitoring question.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/status' }),
  },
  {
    name: 'hearsay_summary',
    readOnly: true,
    description:
      'Headline AI-visibility numbers for the tracked brand: share of AI voice vs competitors, brand mention rate with 95% confidence interval and n, recommendation rate, per-provider breakdown across ChatGPT, Claude, Gemini and Perplexity, open alert count, last run.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/summary${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_intent_results',
    readOnly: true,
    description:
      'Phrasing-robust results per tracked intent (question), pooled across its paraphrases: mention rate with Wilson CI, rerun spread vs phrasing spread (variance decomposition). The most honest per-question number Hearsay has — prefer it over per-prompt results when both exist.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/intents/results${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_prompt_results',
    readOnly: true,
    description:
      'Per-prompt (single paraphrase) results, broken down per provider: brand mention rate, whether the brand is recommended, and which entity leads each prompt. Use for drill-down after hearsay_intent_results, or to inspect competitor prompt-space.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/prompts/results${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_answers_search',
    readOnly: true,
    description:
      'Fetch the raw stored AI answers (the receipts): full text with detected brand/competitor mentions, recommendation flags and cited URLs. Filter by provider (openai|anthropic|gemini|perplexity), entity_id, prompt_id, days. Paged; limit ≤ 50.',
    inputSchema: obj({
      provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'perplexity'] },
      entity_id: { type: 'integer', minimum: 1 },
      prompt_id: { type: 'integer', minimum: 1 },
      days: DAYS,
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    call: (a) => ({ method: 'GET', path: `/api/answers${query(a, ['provider', 'entity_id', 'prompt_id', 'days', 'page', 'limit'], { limit: 'per' })}` }),
  },
  {
    name: 'hearsay_citation_gap',
    readOnly: true,
    description:
      'The action list: domains that AI answers cite in answers where the tracked brand is NOT mentioned — who gets cited instead of you, ranked by frequency. The shortlist of places to earn citations for GEO / AI SEO work.',
    inputSchema: obj({ days: DAYS }),
    call: (a) => ({ method: 'GET', path: `/api/gap${query(a, ['days'])}` }),
  },
  {
    name: 'hearsay_alerts',
    readOnly: true,
    description:
      'List AI-visibility alerts: lost/gained recommendations, competitors overtaking share of AI voice, mention-rate drops — each with severity and the underlying numbers. open_only=true (default) shows unacknowledged alerts.',
    inputSchema: obj({ open_only: { type: 'boolean', description: 'Default true' } }),
    call: (a) => ({ method: 'GET', path: `/api/alerts?open=${a?.open_only === false ? '0' : '1'}` }),
  },
  {
    name: 'hearsay_cost_estimate',
    readOnly: true,
    description:
      'Preview what one measurement panel run would cost before spending anything: total API calls and estimated USD per provider, from the live price table. Costs go to the user’s own provider keys.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/cost/estimate' }),
  },
  {
    name: 'hearsay_suggest_prompts',
    description:
      'Draft tracking intents and paraphrases for the configured brand — the answer to "I don’t know which prompts to track". Returns a DRAFT ONLY; nothing is saved. Show the draft to the human for review, then persist the approved set with hearsay_setup_tracking. Works without provider keys (built-in starter pack).',
    inputSchema: obj({
      category_hint: { type: 'string', description: 'Product category, e.g. "AI meeting notes tool"' },
      keywords: { type: 'string', description: 'Pasted SEO keywords or topics to steer the draft' },
    }),
    call: (a) => ({ method: 'POST', path: '/api/prompts/suggest', body: { category_hint: a?.category_hint, keywords: a?.keywords } }),
  },
  {
    name: 'hearsay_setup_tracking',
    description:
      'Set up or extend AI-visibility tracking in one transactional call: create the brand, competitors, and the intent/paraphrase prompt panel Hearsay measures across ChatGPT, Claude, Gemini and Perplexity. Existing names/prompts are skipped and reported, never duplicated. Only call with prompts the human has reviewed in this conversation.',
    inputSchema: obj({
      brand: obj(ENTITY_FIELDS),
      competitors: { type: 'array', items: obj(ENTITY_FIELDS) },
      intents: {
        type: 'array',
        items: obj(
          {
            label: { type: 'string', description: 'The underlying question, e.g. "best AI meeting notes tool"' },
            category: { type: 'string', enum: ['general', 'comparison', 'use-case', 'local', 'pricing', 'branded'] },
            paraphrases: { type: 'array', items: { type: 'string' }, description: 'Phrasings of this question (≥1, ≤300 chars each)' },
          },
          ['label', 'paraphrases'],
        ),
      },
    }),
    call: (a) => ({ method: 'POST', path: '/api/setup', body: a ?? {} }),
  },
  {
    name: 'hearsay_run_panel',
    description:
      'Start a measurement panel run (every active prompt × enabled provider × samples) using the user’s own API keys. Above the cost threshold this returns a quote_required estimate instead of running — relay the estimate to the human and only retry with confirm:true after they explicitly approve the spend.',
    inputSchema: obj({ confirm: { type: 'boolean', description: 'true = the human approved the quoted cost in this conversation' } }),
    call: (a) => ({ method: 'POST', path: '/api/run', body: { confirm: a?.confirm === true } }),
  },
  {
    name: 'hearsay_run_status',
    readOnly: true,
    description:
      'Progress of the latest measurement run: status (running/done/failed), done_calls/total_calls, timestamps. Poll this after hearsay_run_panel starts a run. Returns no_runs if the instance has never run a panel.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/api/runs/latest' }),
  },
  {
    name: 'hearsay_ack_alert',
    description:
      'Acknowledge one alert by id so it leaves the open list. Use after the human has seen the alert and decided what to do about it.',
    inputSchema: obj({ id: { type: 'integer', minimum: 1, description: 'Alert id from hearsay_alerts' } }, ['id']),
    call: (a) => ({ method: 'POST', path: `/api/alerts/${Number(a.id)}/ack`, body: {} }),
  },
];

/** @param {unknown} id @param {object} result */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
/** @param {unknown} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** @param {{id?: unknown, method?: string, params?: any}} msg */
async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        reply(id, {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hearsay', version: VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'notifications/initialized':
        return; // acknowledged silently
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.readOnly ? { annotations: { readOnlyHint: true, idempotentHint: true } } : {}),
          })),
        });
        return;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        const req = tool.call(params?.arguments ?? {});
        /** @param {boolean} isError @param {string} text */
        const content = (isError, text) =>
          reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60_000);
          const res = await fetch(HEARSAY_URL + req.path, {
            method: req.method,
            headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            signal: controller.signal,
          });
          clearTimeout(timer);
          const text = await res.text();
          content(!res.ok, text);
        } catch {
          content(
            true,
            JSON.stringify({
              error: { code: 'unreachable', message: `Hearsay not reachable at ${HEARSAY_URL} — is \`node server.js\` running?` },
            }),
          );
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    process.stderr.write(`[hearsay-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    if (!isNotification) replyError(id, -32603, 'Internal error');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    try {
      void dispatch(JSON.parse(line));
    } catch {
      replyError(null, -32700, 'Parse error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
