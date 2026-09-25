/**
 * MCP server tests (§15, SPEC §8). No live network: the server talks to a stub
 * Hearsay backend on a loopback port. Every stdout line from the child MUST parse as
 * JSON-RPC — the harness throws (failing the test) on any impurity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePortFile } from '../core/port-discovery.js';

/** Stub Hearsay: routes = { 'GET /api/status': {status, body}, … }. Records requests. */
export async function stubBackend(routes) {
  /** @type {{method: string, url: string, body: string}[]} */
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body });
    const hit = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
    res.writeHead(hit?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit?.body ?? { error: { code: 'not_found', message: 'stub: no route' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Spawn mcp/server.mjs; returns send/next/lines/kill. Every stdout line must parse. */
export function startMcp(hearsayUrlOrEnv) {
  const env = { ...process.env };
  if (typeof hearsayUrlOrEnv === 'string') {
    env.HEARSAY_URL = hearsayUrlOrEnv;
  } else {
    Object.assign(env, hearsayUrlOrEnv);
    if (!Object.prototype.hasOwnProperty.call(hearsayUrlOrEnv, 'HEARSAY_URL')) delete env.HEARSAY_URL;
  }
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  /** @type {unknown[]} */
  const lines = [];
  /** @type {((msg: unknown) => void)[]} */
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line); // throws = stdout purity violation = test failure
      lines.push(msg);
      waiters.shift()?.(msg);
    }
  });
  return {
    lines,
    send: (/** @type {object} */ obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    next: () => new Promise((resolve) => waiters.push(resolve)),
    kill: () => child.kill(),
  };
}

/**
 * @param {ReturnType<typeof startMcp>} mcp @param {string} method @param {object} params @param {number} id
 * @returns {Promise<*>}
 */
export async function rpc(mcp, method, params, id) {
  mcp.send({ jsonrpc: '2.0', id, method, params });
  return mcp.next();
}

test('mcp: initialize handshake, ping, unknown method, notification silence', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);

  const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18'); // echoed: it's one we know
  assert.equal(init.result.serverInfo.name, 'hearsay');
  assert.deepEqual(init.result.capabilities, { tools: {} });

  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no reply expected

  const pong = await rpc(mcp, 'ping', {}, 2);
  assert.deepEqual(pong.result, {});

  const nope = await rpc(mcp, 'bogus/method', {}, 3);
  assert.equal(nope.error.code, -32601);

  // notification produced no line of its own: ids seen are exactly 1,2,3
  assert.deepEqual(mcp.lines.map((l) => /** @type {*} */ (l).id), [1, 2, 3]);
  mcp.kill();
  await backend.close();
});

test('mcp tools/list: subscription surfaces and exploration tools have schemas and read-only annotations', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);
  await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
  const list = await rpc(mcp, 'tools/list', {}, 2);
  const tools = list.result.tools;
  assert.equal(tools.length, 30);
  const names = tools.map((/** @type {*} */ t) => t.name);
  for (const name of [
    'hearsay_status', 'hearsay_summary', 'hearsay_series_list', 'hearsay_series_summary',
    'hearsay_series_export', 'hearsay_intent_evidence', 'hearsay_answer_evidence',
    'hearsay_intent_results', 'hearsay_prompt_results',
    'hearsay_answers_search', 'hearsay_answer_review', 'hearsay_correct_stance',
    'hearsay_stance_rate', 'hearsay_citation_gap', 'hearsay_alerts', 'hearsay_cost_estimate',
    'hearsay_suggest_prompts', 'hearsay_setup_tracking',
    'hearsay_create_benchmark_draft', 'hearsay_review_benchmark_draft',
    'hearsay_approve_benchmark_draft', 'hearsay_run_panel',
    'hearsay_api_search_schedule', 'hearsay_run_status',
    'hearsay_ack_alert', 'hearsay_subscription_preview', 'hearsay_subscription_run',
    'hearsay_subscription_schedule', 'hearsay_exploration_create', 'hearsay_exploration_promote',
  ]) assert.ok(names.includes(name), `missing ${name}`);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} description too thin to trigger on`);
  }
  const readOnly = tools.filter((/** @type {*} */ t) => t.annotations?.readOnlyHint === true).map((/** @type {*} */ t) => t.name).sort();
  assert.deepEqual(readOnly, [
    'hearsay_alerts', 'hearsay_answer_evidence', 'hearsay_answer_review', 'hearsay_answers_search',
    'hearsay_citation_gap', 'hearsay_cost_estimate', 'hearsay_intent_evidence',
    'hearsay_intent_results', 'hearsay_prompt_results', 'hearsay_review_benchmark_draft',
    'hearsay_run_status', 'hearsay_series_export',
    'hearsay_series_list', 'hearsay_series_summary', 'hearsay_stance_rate',
    'hearsay_status', 'hearsay_subscription_preview', 'hearsay_summary',
  ]);
  assert.equal(tools.find((/** @type {*} */ t) => t.name === 'hearsay_ack_alert').inputSchema.required?.includes('id'), true);
  mcp.kill();
  await backend.close();
});

test('mcp tools/call: happy path, param mapping, error mapping, unreachable', async () => {
  const backend = await stubBackend({
    'GET /api/summary': { status: 200, body: { brand: { id: 1, name: 'Acme' }, windowDays: 7 } },
    'GET /api/series': { status: 200, body: { selectedSeriesId: 'series-one', series: [] } },
    'GET /api/series/summary': { status: 200, body: { selectedSeriesId: 'series-one', coverage: {} } },
    'GET /api/series/export': { status: 200, body: { selectedSeriesId: 'series-one', answers: [] } },
    'GET /api/series/evidence': { status: 200, body: { selectedSeriesId: 'series-one', queries: [] } },
    'GET /api/answers/9/evidence': { status: 200, body: { responseId: 9, queries: [] } },
    'GET /api/intents/results': { status: 200, body: { selectedSeriesId: 'series-one', results: [] } },
    'GET /api/prompts/results': { status: 200, body: { selectedSeriesId: 'series-one', results: [] } },
    'GET /api/gap': { status: 200, body: { selectedSeriesId: 'series-one', results: [] } },
    'GET /api/answers': { status: 200, body: { total: 0, page: 1, items: [] } },
    'GET /api/answers/9/review': { status: 200, body: { responseId: 9, revision: 'stance-en-v1', mentions: [] } },
    'POST /api/answers/9/corrections': { status: 200, body: { responseId: 9, correctionCutoff: 1 } },
    'GET /api/stance-rate': { status: 200, body: { n: 1, positive: 0, uncertain: 1 } },
    'POST /api/setup': { status: 422, body: { error: { code: 'validation', message: '1 problem(s) — nothing was saved' }, errors: [] } },
    'POST /api/run': { status: 200, body: { status: 'quote_required', calls: 300, estUsd: 2.4, perProvider: [] } },
    'POST /api/search-schedule': { status: 200, body: { status: 'schedule_confirmation_required' } },
    'POST /api/alerts/7/ack': { status: 200, body: { ok: true } },
  });
  const mcp = startMcp(backend.url);
  await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);

  const call = (/** @type {number} */ id, /** @type {string} */ name, /** @type {object} */ args) =>
    rpc(mcp, 'tools/call', { name, arguments: args }, id);

  const summary = await call(2, 'hearsay_summary', { days: 7 });
  assert.notEqual(summary.result.isError, true);
  assert.equal(JSON.parse(summary.result.content[0].text).brand.name, 'Acme');
  assert.equal(backend.seen.at(-1).url, '/api/summary?days=7');

  await call(20, 'hearsay_series_list', { days: 7 });
  assert.equal(backend.seen.at(-1).url, '/api/series?days=7');
  await call(21, 'hearsay_series_summary', { series_id: 'series-one' });
  assert.equal(backend.seen.at(-1).url, '/api/series/summary?series_id=series-one');
  await call(22, 'hearsay_series_export', { series_id: 'series-one', comparable_only: true });
  assert.equal(backend.seen.at(-1).url, '/api/series/export?series_id=series-one&eligible=1');
  await call(27, 'hearsay_intent_evidence', { series_id: 'series-one', intent_id: 3, days: 7 });
  assert.equal(backend.seen.at(-1).url, '/api/series/evidence?series_id=series-one&intent_id=3&days=7');
  await call(28, 'hearsay_answer_evidence', { answer_id: 9, series_id: 'series-one' });
  assert.equal(backend.seen.at(-1).url, '/api/answers/9/evidence?series_id=series-one');
  await call(24, 'hearsay_intent_results', { series_id: 'series-one' });
  assert.equal(backend.seen.at(-1).url, '/api/intents/results?series_id=series-one');
  await call(25, 'hearsay_prompt_results', { series_id: 'series-one' });
  assert.equal(backend.seen.at(-1).url, '/api/prompts/results?series_id=series-one');
  await call(26, 'hearsay_citation_gap', { series_id: 'series-one' });
  assert.equal(backend.seen.at(-1).url, '/api/gap?series_id=series-one');

  await call(3, 'hearsay_answers_search', { provider: 'perplexity', limit: 10, page: 2 });
  assert.equal(backend.seen.at(-1).url, '/api/answers?provider=perplexity&page=2&per=10');
  await call(23, 'hearsay_answers_search', { series_id: 'series-one', comparable_only: true });
  assert.equal(backend.seen.at(-1).url, '/api/answers?series_id=series-one&eligible=1');

  await call(10, 'hearsay_answer_review', { answer_id: 9, cutoff: 0 });
  assert.equal(backend.seen.at(-1).url, '/api/answers/9/review?cutoff=0');
  await call(11, 'hearsay_correct_stance', { answer_id: 9, interpretation_id: 5,
    previous_correction_id: null, replacement: 'negative', reason: 'Read full answer', request_id: 'mcp-review-1' });
  assert.equal(backend.seen.at(-1).url, '/api/answers/9/corrections');
  assert.equal(JSON.parse(backend.seen.at(-1).body).replacement, 'negative');
  await call(12, 'hearsay_stance_rate', { surface: 'openai-api', entity_id: 1, revision: 'stance-en-v1' });
  assert.equal(backend.seen.at(-1).url, '/api/stance-rate?surface=openai-api&entity_id=1&revision=stance-en-v1');

  const invalid = await call(4, 'hearsay_setup_tracking', { brand: { name: 'X', aliases: ['ab'] } });
  assert.equal(invalid.result.isError, true);
  assert.equal(JSON.parse(invalid.result.content[0].text).error.code, 'validation');

  const quote = await call(5, 'hearsay_run_panel', {});
  assert.notEqual(quote.result.isError, true); // a quote is a successful outcome
  assert.equal(JSON.parse(quote.result.content[0].text).status, 'quote_required');
  assert.equal(JSON.parse(backend.seen.at(-1).body).confirm, false);

  const searchSchedule = await call(9, 'hearsay_api_search_schedule', { action: 'preview', target_ceiling: 5 });
  assert.equal(JSON.parse(searchSchedule.result.content[0].text).status, 'schedule_confirmation_required');
  assert.equal(backend.seen.at(-1).url, '/api/search-schedule');

  await call(8, 'hearsay_subscription_preview', { surfaces: ['codex-agent'], samples: 1 });
  assert.equal(backend.seen.at(-1).url, '/api/subscription/preview');
  assert.deepEqual(JSON.parse(backend.seen.at(-1).body), { surfaces: ['codex-agent'], samples: 1 });

  await call(6, 'hearsay_ack_alert', { id: 7 });
  assert.equal(backend.seen.at(-1).url, '/api/alerts/7/ack');

  const unknown = await call(7, 'hearsay_teleport', {});
  assert.equal(unknown.error.code, -32602);

  mcp.kill();
  await backend.close();

  // unreachable backend → isError content, process stays alive
  const dead = startMcp('http://127.0.0.1:9'); // discard port, nothing listens
  await rpc(dead, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
  const down = await rpc(dead, 'tools/call', { name: 'hearsay_status', arguments: {} }, 2);
  assert.equal(down.result.isError, true);
  assert.equal(JSON.parse(down.result.content[0].text).error.code, 'unreachable');
  const pong = await rpc(dead, 'ping', {}, 3);
  assert.deepEqual(pong.result, {}); // still alive
  dead.kill();
});

test('mcp follows a discovery file created after the process starts', async () => {
  const backend = await stubBackend({
    'GET /api/status': { status: 200, body: { ok: true } },
  });
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-mcp-port-'));
  const portFile = join(directory, 'hearsay.port');
  const mcp = startMcp({ HEARSAY_PORT_FILE: portFile });

  try {
    await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
    writePortFile(portFile, Number(new URL(backend.url).port));
    const reply = await rpc(mcp, 'tools/call', { name: 'hearsay_status', arguments: {} }, 2);
    assert.equal(JSON.parse(reply.result.content[0].text).ok, true);
  } finally {
    mcp.kill();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mcp reports missing discovery instead of contacting port 3000', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-mcp-port-'));
  const missingFile = join(directory, 'missing.port');
  const mcp = startMcp({ HEARSAY_PORT_FILE: missingFile });

  try {
    await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
    const reply = await rpc(mcp, 'tools/call', { name: 'hearsay_status', arguments: {} }, 2);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /not.*started|discovery/i);
    assert.doesNotMatch(reply.result.content[0].text, /127\.0\.0\.1:3000/);
  } finally {
    mcp.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit HEARSAY_URL overrides the discovery file', async () => {
  const backend = await stubBackend({
    'GET /api/status': { status: 200, body: { ok: true } },
  });
  const directory = mkdtempSync(join(tmpdir(), 'hearsay-mcp-port-'));
  const badFile = join(directory, 'bad.port');
  const mcp = startMcp({ HEARSAY_URL: backend.url, HEARSAY_PORT_FILE: badFile });

  try {
    await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
    const reply = await rpc(mcp, 'tools/call', { name: 'hearsay_status', arguments: {} }, 2);
    assert.equal(JSON.parse(reply.result.content[0].text).ok, true);
  } finally {
    mcp.kill();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mcp: piped stdin — replies to all requests land before exit (drain on end)', async () => {
  const backend = await stubBackend({
    'GET /api/status': { status: 200, body: { version: '0.1.0', demo: true, configured: true } },
  });
  const { spawn: spawnChild } = await import('node:child_process');
  const child = spawnChild(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: backend.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hearsay_status","arguments":{}}}',
  ];
  child.stdin.end(`${lines.join('\n')}\n`); // pipe-and-close, like the §19.5 gate does
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, 2]); // the async tools/call reply survived stdin close
  assert.equal(JSON.parse(replies[1].result.content[0].text).configured, true);
  await backend.close();
});

test('mcp: a `null` line gets -32600 Invalid Request and never kills the session', async () => {
  const backend = await stubBackend({});
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: backend.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `JSON.parse('null')` succeeds — this line is valid JSON but not a valid Request.
  child.stdin.end('null\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  const [code] = await once(child, 'close');
  await backend.close(); // close before asserting so a failure cannot hang the suite
  assert.equal(code, 0, 'a malformed request must not tear the process down');
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].id, null);
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies[1].id, 1);
  assert.deepEqual(replies[1].result, {}); // the ping after the bad line still answered
});

test('mcp: JSON-RPC batch is unrolled — every request in it gets a reply (2025-03-26)', async () => {
  const backend = await stubBackend({});
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: backend.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}',
    '[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","id":3,"method":"tools/list"}]',
    '[]',
  ];
  child.stdin.end(`${lines.join('\n')}\n`);
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  const [code] = await once(child, 'close');
  await backend.close();
  assert.equal(code, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  // The server offers 2025-03-26 — a revision whose spec REQUIRED batch support — so a
  // batch must never be silently swallowed.
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, null]);
  assert.deepEqual(replies[1].result, {});
  assert.ok(Array.isArray(replies[2].result.tools) && replies[2].result.tools.length > 0);
  assert.equal(replies[3].error.code, -32600); // an empty batch is an invalid request
});

test('mcp: a backend that stalls mid-body cannot hang tools/call past the timeout', async () => {
  // Stub that sends headers, streams half a body, then stalls forever. The old code
  // cleared its abort timer as soon as headers arrived, so res.text() hung unbounded.
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    // never ends
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: `http://127.0.0.1:${port}`, HEARSAY_MCP_TIMEOUT_MS: '250' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Watchdog: a regression here would otherwise hang the suite, not just fail it.
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hearsay_status","arguments":{}}}',
  ];
  child.stdin.end(`${lines.join('\n')}\n`);
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  const [code] = await once(child, 'close');
  clearTimeout(watchdog);
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, 'drain-and-exit must not block on a stalled body');
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
  assert.equal(replies[1].result.isError, true);
  const payload = JSON.parse(replies[1].result.content[0].text);
  assert.equal(payload.error.code, 'timeout'); // reachable-but-stalled is not "unreachable"
});

test('mcp: a final request without a trailing newline is still answered on stdin close', async () => {
  const backend = await stubBackend({});
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: backend.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // No terminating \n — ndjson consumers conventionally accept a final bare record.
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  const [code] = await once(child, 'close');
  await backend.close();
  assert.equal(code, 0);
  const replies = out.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.equal(replies.length, 1, 'the unterminated request must not vanish');
  assert.equal(replies[0].id, 1);
  assert.ok(Array.isArray(replies[0].result.tools));
});

test('mcp: unknown protocolVersion → server answers with its own latest', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);
  const init = await rpc(mcp, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }, 1);
  assert.match(init.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(init.result.protocolVersion, '1999-01-01');
  mcp.kill();
  await backend.close();
});
