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
export function startMcp(hearsayUrl) {
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    env: { ...process.env, HEARSAY_URL: hearsayUrl },
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

test('mcp tools/list: exactly 13 tools, schemas, read-only annotations', async () => {
  const backend = await stubBackend({});
  const mcp = startMcp(backend.url);
  await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, 1);
  const list = await rpc(mcp, 'tools/list', {}, 2);
  const tools = list.result.tools;
  assert.equal(tools.length, 13);
  const names = tools.map((/** @type {*} */ t) => t.name);
  for (const name of [
    'hearsay_status', 'hearsay_summary', 'hearsay_intent_results', 'hearsay_prompt_results',
    'hearsay_answers_search', 'hearsay_citation_gap', 'hearsay_alerts', 'hearsay_cost_estimate',
    'hearsay_suggest_prompts', 'hearsay_setup_tracking', 'hearsay_run_panel', 'hearsay_run_status',
    'hearsay_ack_alert',
  ]) assert.ok(names.includes(name), `missing ${name}`);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} description too thin to trigger on`);
  }
  const readOnly = tools.filter((/** @type {*} */ t) => t.annotations?.readOnlyHint === true).map((/** @type {*} */ t) => t.name).sort();
  assert.deepEqual(readOnly, [
    'hearsay_alerts', 'hearsay_answers_search', 'hearsay_citation_gap', 'hearsay_cost_estimate',
    'hearsay_intent_results', 'hearsay_prompt_results', 'hearsay_run_status', 'hearsay_status',
    'hearsay_summary',
  ]);
  assert.equal(tools.find((/** @type {*} */ t) => t.name === 'hearsay_ack_alert').inputSchema.required?.includes('id'), true);
  mcp.kill();
  await backend.close();
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
