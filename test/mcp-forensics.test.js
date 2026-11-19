/**
 * Tests for Wave 2 MCP forensics/site-check tools (`mcp/server.mjs`) and
 * Evidence Dossier v2 (`core/client-export.js`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildClientReport,
  renderClientReport,
  renderClientReportHtml,
  sanitizeWhiteLabelOptions,
} from '../core/client-export.js';
import { openDb, run } from '../core/db.js';
import { storeInterpretation } from '../core/interpretations.js';

/** Stub Hearsay HTTP server for MCP proxy tests. */
async function stubBackend(routes) {
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

/** Spawn `mcp/server.mjs` and enforce strict JSON-RPC stdout purity. */
function startMcp(hearsayUrlOrEnv) {
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
      const msg = JSON.parse(line);
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

/** @param {ReturnType<typeof startMcp>} mcp @param {string} method @param {object} params @param {number} id */
async function rpc(mcp, method, params, id) {
  mcp.send({ jsonrpc: '2.0', id, method, params });
  return /** @type {Promise<any>} */ (mcp.next());
}

/**
 * Populate a SQLite database with rich multi-wave forensics data:
 * - Retrieved-but-dropped brand & third-party URLs
 * - Own-site hijack (brand URL cited, competitor positively recommended, brand neutral)
 * - Paired (openai, gpt-5.6-luna) parametric memory vs. live retrieval prompts
 * - Unpaired (anthropic, claude-sonnet-5) memory-only prompt
 * - 3 completed measurement waves with durable, recurring, and ephemeral off-site citations
 * - Multiple paraphrases & reruns for phrasing-vs-rerun spread
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedForensicsFixture(db) {
  const createdAt = '2026-10-01T00:00:00Z';
  run(
    db,
    `INSERT INTO entities(id, name, aliases, domains, is_self, created_at)
     VALUES(1, 'AcmeFlow', '["Acme Flow"]', '["acmeflow.io"]', 1, ?)`,
    [createdAt],
  );
  run(
    db,
    `INSERT INTO entities(id, name, aliases, domains, is_self, created_at)
     VALUES(2, 'RivalOps', '[]', '["rivalops.com"]', 0, ?)`,
    [createdAt],
  );

  run(db, `INSERT INTO intents(id, label, created_at) VALUES(1, 'Best workflow automation platform', ?)`, [createdAt]);
  run(
    db,
    `INSERT INTO prompts(id, intent_id, text, category, active, tracking_state, created_at)
     VALUES
       (1, 1, 'What is the best workflow automation tool for SaaS teams?', 'general', 1, 'tracking', ?),
       (2, 1, 'Which SaaS workflow automation platform has the cleanest API?', 'general', 1, 'tracking', ?),
       (3, 1, 'Top workflow automation software for enterprise ops', 'comparison', 1, 'tracking', ?)`,
    [createdAt, createdAt, createdAt],
  );

  // 4 completed runs (waves) for grounded search + 1 baseline completed run for parametric memory
  run(
    db,
    `INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls)
     VALUES
       (1, '2026-10-05T08:00:00Z', '2026-10-05T08:05:00Z', 'api', 'done', 4, 4),
       (2, '2026-10-12T08:00:00Z', '2026-10-12T08:05:00Z', 'api', 'done', 3, 3),
       (3, '2026-10-19T08:00:00Z', '2026-10-19T08:05:00Z', 'api', 'done', 3, 3),
       (4, '2026-10-04T08:00:00Z', '2026-10-04T08:05:00Z', 'api', 'done', 4, 4),
       (5, '2026-10-22T08:00:00Z', '2026-10-22T08:05:00Z', 'api', 'done', 1, 1)`,
  );

  /**
   * @param {object} r
   */
  const addResponse = (r) =>
    Number(
      run(
        db,
        `INSERT INTO responses(
          id, run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
          lane, target_status, comparability_status, answer_status, web_status,
          execution_profile_id, benchmark_revision_id, analysis_revision, comparison_key, search_policy
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracking', 'completed', 'comparable', 'complete', ?, NULL, NULL, 'stance-v1', ?, ?)`,
        [
          r.id,
          r.runId,
          r.promptId,
          r.provider,
          r.surface,
          r.model,
          r.sampleIdx ?? 0,
          r.text,
          r.createdAt,
          r.webStatus,
          r.comparisonKey,
          r.searchPolicy,
        ],
      ).lastInsertRowid,
    );

  /**
   * @param {number} responseId
   * @param {number} entityId
   * @param {'positive'|'neutral'|'negative'} stance
   * @param {number} rank
   * @param {string} at
   */
  const addMention = (responseId, entityId, stance, rank, at) => {
    const mid = Number(
      run(
        db,
        `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, recommended, snippet, rank)
         VALUES(?, ?, 0, 1, ?, 'snippet', ?)`,
        [responseId, entityId, stance === 'positive' ? 1 : 0, rank],
      ).lastInsertRowid,
    );
    storeInterpretation(
      db,
      mid,
      'stance-v1',
      /** @type {*} */ ({
        stance,
        rule_id: `rule-${stance}`,
        evidence_start: 0,
        evidence_end: 7,
        review_flags: [],
      }),
      at,
    );
  };

  // --- Wave 1 (Grounded openai-api, gpt-5.6-luna) ---
  // Resp 101 (Prompt 1, sample 0): AcmeFlow mentioned+positive, acmeflow.io/pricing RETRIEVED but DROPPED,
  // acmeflow.io/guide RETRIEVED & CITED, durable-review.example CITED.
  addResponse({
    id: 101,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'AcmeFlow is strongly recommended for SaaS workflow automation.',
    createdAt: '2026-10-05T08:01:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(101, 1, 'positive', 1, '2026-10-05T08:01:00Z');
  const s101a = run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance, original_order)
     VALUES(101, 'https://acmeflow.io/pricing', 'https://acmeflow.io/pricing', 'search_result', 1)`,
  ).lastInsertRowid;
  const s101b = run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance, original_order)
     VALUES(101, 'https://acmeflow.io/guide', 'https://acmeflow.io/guide', 'search_result', 2)`,
  ).lastInsertRowid;
  run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance, original_order)
     VALUES(101, 'https://dropped-third.example/list', 'https://dropped-third.example/list', 'search_result', 3)`,
  );
  run(
    db,
    `INSERT INTO answer_citations(response_id, source_observation_id, url, provenance, ordinal)
     VALUES(101, ?, 'https://acmeflow.io/guide', 'native_annotation', 0)`,
    [s101b],
  );
  // Keep s101a unused (dropped)
  assert.ok(Number(s101a) > 0);

  // Resp 102 (Prompt 1, sample 1): Reruns differ (RivalOps positive, AcmeFlow omitted -> rerun spread!)
  // Cites durable-review.example & recurring-bench.example (off-site targets!)
  addResponse({
    id: 102,
    runId: 1,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 1,
    text: 'RivalOps is the top choice for workflow automation.',
    createdAt: '2026-10-05T08:02:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(102, 2, 'positive', 1, '2026-10-05T08:02:00Z');
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
     VALUES
       (102, 'https://durable-review.example/best-automation', 'native_annotation', 0),
       (102, 'https://recurring-bench.example/compare', 'native_annotation', 1),
       (102, 'https://ephemeral-blog.example/wave1', 'native_annotation', 2)`,
  );

  // Resp 103 (Prompt 2, sample 0): OWN-SITE HIJACK!
  // Cites acmeflow.io/docs (brand-owned), mentions AcmeFlow neutrally, recommends RivalOps positively!
  addResponse({
    id: 103,
    runId: 1,
    promptId: 2,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'While AcmeFlow documents webhook limits, RivalOps is recommended for its cleaner API.',
    createdAt: '2026-10-05T08:03:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(103, 1, 'neutral', 1, '2026-10-05T08:03:00Z');
  addMention(103, 2, 'positive', 2, '2026-10-05T08:03:00Z');
  run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance, original_order)
     VALUES(103, 'https://acmeflow.io/docs', 'https://acmeflow.io/docs', 'search_result', 1)`,
  );
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
     VALUES(103, 'https://acmeflow.io/docs', 'native_annotation', 0)`,
  );

  // Resp 104 (Prompt 3, sample 0): Grounded answer omits AcmeFlow completely (for memory_displaced test!)
  addResponse({
    id: 104,
    runId: 1,
    promptId: 3,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'RivalOps dominates enterprise workflow automation.',
    createdAt: '2026-10-05T08:04:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(104, 2, 'positive', 1, '2026-10-05T08:04:00Z');

  // --- Wave 2 (Grounded openai-api, gpt-5.6-luna) ---
  addResponse({
    id: 201,
    runId: 2,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'RivalOps leads in automation reviews.',
    createdAt: '2026-10-12T08:01:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(201, 2, 'positive', 1, '2026-10-12T08:01:00Z');
  run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance, original_order)
     VALUES(201, 'https://acmeflow.io/pricing', 'https://acmeflow.io/pricing', 'search_result', 1)`,
  );
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
     VALUES
       (201, 'https://durable-review.example/best-automation', 'native_annotation', 0),
       (201, 'https://recurring-bench.example/compare', 'native_annotation', 1)`,
  );

  // --- Wave 3 (Grounded openai-api, gpt-5.6-luna) ---
  addResponse({
    id: 301,
    runId: 3,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'RivalOps remains the top recommended workflow tool.',
    createdAt: '2026-10-19T08:01:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(301, 2, 'positive', 1, '2026-10-19T08:01:00Z');
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
     VALUES(301, 'https://durable-review.example/best-automation', 'native_annotation', 0)`,
  );

  // --- Wave 5 (4th grounded wave so 3/4 = durable, 2/4 = recurring, 1/4 = ephemeral) ---
  addResponse({
    id: 501,
    runId: 5,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'RivalOps continues to rank first in workflow guides.',
    createdAt: '2026-10-22T08:01:00Z',
    webStatus: 'verified',
    comparisonKey: 'cmp-grounded',
    searchPolicy: 'required',
  });
  addMention(501, 2, 'positive', 1, '2026-10-22T08:01:00Z');
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
     VALUES(501, 'https://other-wave4.example/guide', 'native_annotation', 0)`,
  );

  // --- Wave 4 (Parametric Memory: search_policy='off', web_status='not_used') ---
  // Prompt 1: AcmeFlow present in memory AND grounded -> memory_anchored
  addResponse({
    id: 401,
    runId: 4,
    promptId: 1,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'AcmeFlow is a solid choice from memory.',
    createdAt: '2026-10-04T08:01:00Z',
    webStatus: 'not_used',
    comparisonKey: 'cmp-memory',
    searchPolicy: 'off',
  });
  addMention(401, 1, 'positive', 1, '2026-10-04T08:01:00Z');

  // Prompt 2: AcmeFlow ABSENT in memory, present in grounded -> search_dependent
  addResponse({
    id: 402,
    runId: 4,
    promptId: 2,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'RivalOps is known for its API.',
    createdAt: '2026-10-04T08:02:00Z',
    webStatus: 'not_used',
    comparisonKey: 'cmp-memory',
    searchPolicy: 'off',
  });
  addMention(402, 2, 'positive', 1, '2026-10-04T08:02:00Z');

  // Prompt 3: AcmeFlow PRESENT in memory, ABSENT in grounded -> memory_displaced
  addResponse({
    id: 403,
    runId: 4,
    promptId: 3,
    provider: 'openai',
    surface: 'openai-api',
    model: 'gpt-5.6-luna',
    sampleIdx: 0,
    text: 'AcmeFlow is recommended for enterprise ops.',
    createdAt: '2026-10-04T08:03:00Z',
    webStatus: 'not_used',
    comparisonKey: 'cmp-memory',
    searchPolicy: 'off',
  });
  addMention(403, 1, 'positive', 1, '2026-10-04T08:03:00Z');

  // Unpaired model (anthropic/claude-sonnet-5 memory-only) to verify honest unpaired disclosure
  addResponse({
    id: 404,
    runId: 4,
    promptId: 1,
    provider: 'anthropic',
    surface: 'anthropic-api',
    model: 'claude-sonnet-5',
    sampleIdx: 0,
    text: 'AcmeFlow is an option.',
    createdAt: '2026-10-04T08:04:00Z',
    webStatus: 'not_used',
    comparisonKey: 'cmp-claude-mem',
    searchPolicy: 'off',
  });
  addMention(404, 1, 'neutral', 1, '2026-10-04T08:04:00Z');
}

test('mcp tools/list exposes all 4 new forensics & site-check tools with schemas and read-only hints', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-mcp-list-'));
  const mcp = startMcp({ HEARSAY_PORT_FILE: join(dir, 'missing.port') });
  t.after(() => {
    mcp.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  await rpc(mcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const list = await rpc(mcp, 'tools/list', {}, 2);
  const byName = new Map(list.result.tools.map((tool) => [tool.name, tool]));

  const siteCheck = byName.get('hearsay_site_check');
  assert.ok(siteCheck, 'hearsay_site_check must be listed');
  assert.equal(siteCheck.annotations?.readOnlyHint, true);
  assert.deepEqual(siteCheck.inputSchema.required, ['url']);
  assert.equal(siteCheck.inputSchema.properties.browser.type, 'boolean');
  assert.equal(siteCheck.inputSchema.properties.timeoutMs.type, 'integer');
  assert.equal(siteCheck.inputSchema.properties.allowPrivateHosts, undefined, 'SSRF override must never be exposed in tool schema');

  for (const name of [
    'hearsay_retrieval_attrition',
    'hearsay_memory_vs_search',
    'hearsay_citation_persistence',
  ]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be listed`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.properties.surface);
    assert.ok(tool.inputSchema.properties.provider);
    assert.ok(tool.inputSchema.properties.model);
    assert.ok(tool.inputSchema.properties.include_seeded);
  }
  assert.ok(byName.get('hearsay_retrieval_attrition').inputSchema.properties.limit);
});

test('mcp hearsay_site_check runs directly with zero server/keys, enforces SSRF guard by default, and audits ephemeral HTTP server', async (t) => {
  // Ephemeral target website serving HTML + robots.txt blocking OAI-SearchBot
  const targetServer = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(`<!doctype html>
      <html>
        <head>
          <title>AcmeFlow — Workflow Automation</title>
          <meta name="description" content="Fast B2B workflow automation platform." />
          <link rel="canonical" href="http://127.0.0.1:${port}/" />
        </head>
        <body>
          <main>
            <h1>AcmeFlow Workflow Automation</h1>
            <p>AcmeFlow helps B2B engineering and operations teams automate complex approval pipelines with auditable webhooks, predictable retries, and transparent usage metering.</p>
          </main>
        </body>
      </html>`);
  });
  targetServer.listen(0, '127.0.0.1');
  await once(targetServer, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (targetServer.address());
  const targetUrl = `http://127.0.0.1:${port}/`;

  const dir = mkdtempSync(join(tmpdir(), 'hearsay-mcp-site-'));
  const missingPortFile = join(dir, 'no-server.port');

  // 1. Default MCP instance (NO server.js, NO API keys, SSRF guard ENABLED by default!)
  const guardedMcp = startMcp({
    HEARSAY_PORT_FILE: missingPortFile,
    HEARSAY_SITE_CHECK_ALLOW_PRIVATE_HOSTS: '0',
  });
  // 2. Test-harness MCP instance with explicit env opt-in to hit ephemeral loopback server
  const localMcp = startMcp({
    HEARSAY_PORT_FILE: missingPortFile,
    HEARSAY_SITE_CHECK_ALLOW_PRIVATE_HOSTS: '1',
  });

  t.after(async () => {
    guardedMcp.kill();
    localMcp.kill();
    await new Promise((r) => targetServer.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  await rpc(guardedMcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const blockedLoopback = await rpc(
    guardedMcp,
    'tools/call',
    { name: 'hearsay_site_check', arguments: { url: targetUrl } },
    2,
  );
  assert.equal(blockedLoopback.result.isError, true);
  assert.equal(JSON.parse(blockedLoopback.result.content[0].text).error.code, 'ssrf_blocked');

  const blockedMetadata = await rpc(
    guardedMcp,
    'tools/call',
    { name: 'hearsay_site_check', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
    3,
  );
  assert.equal(blockedMetadata.result.isError, true);
  assert.equal(JSON.parse(blockedMetadata.result.content[0].text).error.code, 'ssrf_blocked');

  const invalidProto = await rpc(
    guardedMcp,
    'tools/call',
    { name: 'hearsay_site_check', arguments: { url: 'file:///etc/passwd' } },
    4,
  );
  assert.equal(invalidProto.result.isError, true);
  assert.equal(JSON.parse(invalidProto.result.content[0].text).error.code, 'invalid_url');

  // Now run direct audit against ephemeral HTTP server (ZERO server.js running!)
  await rpc(localMcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const audit = await rpc(
    localMcp,
    'tools/call',
    { name: 'hearsay_site_check', arguments: { url: targetUrl, browser: false, timeoutMs: 5000 } },
    2,
  );
  assert.notEqual(audit.result.isError, true);
  assert.equal(audit.result.content.length, 2, 'returns structured JSON + concise text summary');

  const parsed = JSON.parse(audit.result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meta.title, 'AcmeFlow — Workflow Automation');
  assert.equal(parsed.robotsTxt.fetched, true);
  assert.equal(
    parsed.robotsTxt.crawlers.find((c) => c.bot === 'OAI-SearchBot')?.allowed,
    false,
  );
  assert.equal(
    parsed.robotsTxt.crawlers.find((c) => c.bot === 'Googlebot')?.allowed,
    true,
  );
  assert.equal(parsed.summary.grade, 'fail', 'blocking OAI-SearchBot triggers critical finding');
  assert.match(parsed.summaryText, /Hearsay Site Check: FAIL/);
  assert.match(audit.result.content[1].text, /OAI-SearchBot/);
});

test('mcp forensics tools proxy local HTTP API when running and fall back cleanly to read-only SQLite when server is down', async (t) => {
  // Part A: HTTP proxy mode when local server IS running
  const backend = await stubBackend({
    'GET /api/forensics/attrition': { status: 200, body: { n: 5, source: 'http_stub', hijacks: { count: 1 } } },
    'GET /api/forensics/memory-vs-search': { status: 200, body: { pairs: [], source: 'http_stub' } },
    'GET /api/forensics/persistence': { status: 200, body: { totalWaves: 2, source: 'http_stub' } },
  });
  const mcpHttp = startMcp(backend.url);

  // Part B: Direct read-only SQLite fallback (no server.js running + missing discovery file)
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-mcp-forensics-'));
  const dbPath = join(dir, 'hearsay.db');
  const db = openDb(dbPath);
  seedForensicsFixture(db);
  db.close();

  const mcpFallback = startMcp({
    HEARSAY_PORT_FILE: join(dir, 'missing.port'),
    HEARSAY_DB_PATH: dbPath,
  });

  // Part C: Unreachable HEARSAY_URL also falls back cleanly to SQLite
  const mcpDeadUrlFallback = startMcp({
    HEARSAY_URL: 'http://127.0.0.1:9',
    HEARSAY_DB_PATH: dbPath,
  });

  // Part D: Neither server nor DB exists -> clean db_unavailable error
  const mcpNoDb = startMcp({
    HEARSAY_PORT_FILE: join(dir, 'missing.port'),
    HEARSAY_DB_PATH: join(dir, 'does-not-exist.db'),
  });

  t.after(async () => {
    mcpHttp.kill();
    mcpFallback.kill();
    mcpDeadUrlFallback.kill();
    mcpNoDb.kill();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Verify HTTP proxy paths & query param mapping
  await rpc(mcpHttp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const httpAttr = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_retrieval_attrition', arguments: { provider: 'openai', include_seeded: true, limit: 10 } },
    2,
  );
  assert.notEqual(httpAttr.result.isError, true);
  assert.equal(JSON.parse(httpAttr.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/forensics/attrition?provider=openai&include_seeded=1&limit=10');

  const httpMem = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_memory_vs_search', arguments: { surface: 'openai-api', model: 'gpt-5.6-luna' } },
    3,
  );
  assert.equal(JSON.parse(httpMem.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/forensics/memory-vs-search?surface=openai-api&model=gpt-5.6-luna');

  const httpPers = await rpc(
    mcpHttp,
    'tools/call',
    { name: 'hearsay_citation_persistence', arguments: { run_id: 2, exclude_branded: true } },
    4,
  );
  assert.equal(JSON.parse(httpPers.result.content[0].text).source, 'http_stub');
  assert.equal(backend.seen.at(-1).url, '/api/forensics/persistence?run_id=2&exclude_branded=1');

  // Verify Direct SQLite read-only fallback for all 3 tools
  await rpc(mcpFallback, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);

  const fbAttr = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_retrieval_attrition', arguments: { provider: 'openai' } },
    2,
  );
  assert.notEqual(fbAttr.result.isError, true);
  const attrJson = JSON.parse(fbAttr.result.content[0].text);
  assert.equal(attrJson.dataSource, 'sqlite_readonly');
  assert.ok(attrJson.topDroppedBrandUrls.some((u) => u.url === 'https://acmeflow.io/pricing'));
  assert.equal(attrJson.hijacks.count, 1);
  assert.deepEqual(attrJson.hijacks.receipts[0].recommendedCompetitors, ['RivalOps']);

  const fbMem = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_memory_vs_search', arguments: {} },
    3,
  );
  assert.notEqual(fbMem.result.isError, true);
  const memJson = JSON.parse(fbMem.result.content[0].text);
  assert.equal(memJson.dataSource, 'sqlite_readonly');
  assert.equal(memJson.summary.pairedModels, 1);
  assert.equal(memJson.summary.unpairedModels, 1);
  const openaiPair = memJson.pairs.find((p) => p.provider === 'openai');
  assert.equal(openaiPair.status, 'paired');
  assert.deepEqual(openaiPair.classificationSummary, {
    memory_anchored: 1,
    search_dependent: 1,
    memory_displaced: 1,
    absent_in_both: 0,
  });

  const fbPers = await rpc(
    mcpFallback,
    'tools/call',
    { name: 'hearsay_citation_persistence', arguments: { search_policy: 'required' } },
    4,
  );
  assert.notEqual(fbPers.result.isError, true);
  const persJson = JSON.parse(fbPers.result.content[0].text);
  assert.equal(persJson.dataSource, 'sqlite_readonly');
  assert.equal(persJson.totalWaves, 4);
  const durableTarget = persJson.offSiteTargets.find(
    (u) => u.url === 'https://durable-review.example/best-automation',
  );
  assert.ok(durableTarget, 'durable off-site target must be present');
  assert.equal(durableTarget.tier, 'durable');
  assert.equal(durableTarget.wavesSeen, 3);
  const recurringTarget = persJson.offSiteTargets.find(
    (u) => u.url === 'https://recurring-bench.example/compare',
  );
  assert.ok(recurringTarget, 'recurring off-site target must be present');
  assert.equal(recurringTarget.tier, 'recurring');
  assert.equal(recurringTarget.wavesSeen, 2);

  // Verify unreachable HEARSAY_URL falls back cleanly to SQLite too
  await rpc(mcpDeadUrlFallback, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const deadFb = await rpc(
    mcpDeadUrlFallback,
    'tools/call',
    { name: 'hearsay_retrieval_attrition', arguments: {} },
    2,
  );
  assert.notEqual(deadFb.result.isError, true);
  assert.equal(JSON.parse(deadFb.result.content[0].text).dataSource, 'sqlite_readonly');

  // Verify missing DB returns clean db_unavailable without creating a DB file
  await rpc(mcpNoDb, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const missingDbRes = await rpc(
    mcpNoDb,
    'tools/call',
    { name: 'hearsay_citation_persistence', arguments: {} },
    2,
  );
  assert.equal(missingDbRes.result.isError, true);
  assert.equal(JSON.parse(missingDbRes.result.content[0].text).error.code, 'db_unavailable');
});

test('Evidence Dossier v2 renders white-label branding safely, rejects CSS injection, and preserves Hearsay defaults', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedForensicsFixture(db);
  const now = '2026-10-25T00:00:00Z';

  // Sanitizer unit checks
  assert.deepEqual(sanitizeWhiteLabelOptions({}), {
    brandLabel: null,
    accentColor: null,
    footerNote: null,
  });
  assert.equal(sanitizeWhiteLabelOptions({ accentColor: '#e11d48' }).accentColor, '#e11d48');
  assert.equal(sanitizeWhiteLabelOptions({ accentColor: '#abc' }).accentColor, '#abc');
  assert.equal(sanitizeWhiteLabelOptions({ accentColor: '#112233aa' }).accentColor, '#112233aa');
  for (const evil of [
    '#ff0000; } body { display: none; } /*',
    'url(https://evil.example/leak)',
    'expression(alert(1))',
    'rgb(255, 0, 0)',
    'red',
    '#12',
    '#12345',
    '#1234567',
    '#123456789',
    '#gggggg',
    'javascript:alert(1)',
  ]) {
    assert.equal(
      sanitizeWhiteLabelOptions({ accentColor: evil }).accentColor,
      null,
      `invalid accentColor "${evil}" must be rejected`,
    );
  }

  // Default branding when white-label options omitted
  const defaultReport = buildClientReport(db, { days: 30, now });
  const defaultHtml = renderClientReportHtml(defaultReport);
  assert.match(defaultHtml, /Hearsay · B2B AI Visibility Audit/);
  assert.match(defaultHtml, /Generated by Hearsay \(MIT, local-first AI recommendation evidence\)/);

  // Custom white-label options with hostile HTML & valid accent color
  const customHtml = renderClientReport(defaultReport, {
    brandLabel: 'Northstar <SEO> & "Labs"',
    accentColor: '#e11d48',
    footerNote: 'Prepared exclusively for <Acme> · Do not redistribute',
  });
  assert.ok(customHtml.includes('Northstar &lt;SEO&gt; &amp; &quot;Labs&quot;'));
  assert.ok(customHtml.includes('Prepared exclusively for &lt;Acme&gt; · Do not redistribute'));
  assert.ok(customHtml.includes('--accent: #e11d48;'));
  assert.equal(customHtml.includes('<SEO>'), false);
  assert.equal(customHtml.includes('<Acme>'), false);

  // CSS injection payload in accentColor must NEVER appear in rendered HTML/CSS
  const injectionPayload = '#ff0000; } body { background: url(https://evil.example/pwn); } /*';
  const injectedReport = buildClientReport(db, {
    days: 30,
    now,
    accentColor: injectionPayload,
    brandLabel: 'Agency <script>alert(1)</script>',
  });
  const safeHtml = renderClientReportHtml(injectedReport);
  assert.equal(safeHtml.includes('evil.example/pwn'), false);
  assert.equal(safeHtml.includes(injectionPayload), false);
  assert.equal(safeHtml.includes('<script>alert(1)</script>'), false);
  assert.ok(safeHtml.includes('Agency &lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('Evidence Dossier v2 includes volatility callout, Mention/Citation/Recommendation separation bars, and all 3 forensics sections', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedForensicsFixture(db);

  const now = '2026-10-25T00:00:00Z';
  const report = buildClientReport(db, { days: 30, now });

  // Verify model metrics
  assert.ok(report.kpis.mentionRate);
  assert.ok(report.kpis.citationRate);
  assert.ok(report.kpis.recommendationRate);
  assert.equal(report.kpis.brandDomainsConfigured, true);
  assert.ok(report.kpis.citationRate.cited >= 2, 'acmeflow.io/guide and acmeflow.io/docs cited');
  assert.equal(report.kpis.recommendationRate.recommended, 1, 'only response 101 has positive stance for AcmeFlow');
  assert.ok(
    report.kpis.citationRate.p > report.kpis.recommendationRate.p,
    'brand cited more often than positively recommended (own-site hijack scenario)',
  );

  // Verify volatility metrics
  assert.ok(report.volatility.maxPhrasingSpread !== null);
  assert.ok(report.volatility.maxRerunSpread !== null);

  // Verify all 3 forensics reports populated
  assert.ok(report.forensics.attrition.topDroppedBrandUrls.some((u) => u.url === 'https://acmeflow.io/pricing'));
  assert.equal(report.forensics.attrition.hijacks.count, 1);
  assert.equal(report.forensics.memoryVsSearch.summary.pairedModels, 1);
  assert.equal(report.forensics.persistence.totalWaves, 4);
  assert.ok(report.forensics.persistence.offSiteTargets.some((u) => u.tier === 'durable'));
  assert.ok(report.forensics.persistence.offSiteTargets.some((u) => u.tier === 'recurring'));

  const html = renderClientReportHtml(report);

  // 1. Volatility callout box
  assert.match(html, /Why Live Chat on Your Phone May Differ/);
  assert.match(html, /95% Wilson/);
  assert.match(html, /Paraphrase vs\. Rerun Spread/);
  assert.match(html, /Explicit Surface Scope/);

  // 2. Mention vs. Citation vs. Positive Recommendation separation bars
  assert.match(html, /Mention vs\. Citation vs\. Positive Recommendation/);
  assert.match(html, /1\. Mention Rate/);
  assert.match(html, /2\. Brand Citation Rate/);
  assert.match(html, /3\. Positive Recommendation/);
  assert.match(html, /sep-tone-citation/);
  assert.match(html, /AI models can cite your pages while recommending a competitor/);

  // 3. Retrieved-but-Dropped Attrition & Own-Site Hijacks section
  assert.match(html, /Retrieved-but-Dropped Attrition &amp; Own-Site Hijacks/);
  assert.ok(html.includes('https://acmeflow.io/pricing'));
  assert.ok(html.includes('https://dropped-third.example/list'));
  assert.match(html, /Own-Site Hijack Receipts/);
  assert.ok(html.includes('https://acmeflow.io/docs'));

  // 4. Parametric Memory vs. Grounded Search Delta section
  assert.match(html, /Parametric Memory vs\. Grounded Search Delta/);
  assert.ok(html.includes('openai / gpt-5.6-luna'));
  assert.match(html, /memory_anchored/);
  assert.match(html, /search_dependent/);
  assert.match(html, /memory_displaced/);
  assert.match(html, /anthropic\/claude-sonnet-5/);

  // 5. Persistent Off-Site Targets section
  assert.match(html, /Persistent Off-Site Targets/);
  assert.match(html, /Off-Site Citation Share/);
  assert.ok(html.includes('durable-review.example'));
  assert.ok(html.includes('recurring-bench.example'));
  assert.match(html, /pill-good">durable</);
  assert.match(html, /pill-accent">recurring</);

  // Inline script remains valid JS
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));
});

test('Evidence Dossier v2 honestly displays single_wave_unverified on 1-wave data and stays backwards-compatible with legacy report shapes', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());

  const now = '2026-10-15T12:00:00Z';
  run(db, `INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES(1, 'SoloBrand', '[]', '["solobrand.io"]', 1, ?)`, [now]);
  run(db, `INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES(2, 'CompX', '[]', '["compx.io"]', 0, ?)`, [now]);
  run(db, `INSERT INTO intents(id, label, created_at) VALUES(1, 'Best widget', ?)`, [now]);
  run(db, `INSERT INTO prompts(id, intent_id, text, category, active, tracking_state, created_at) VALUES(1, 1, 'Best widget?', 'general', 1, 'tracking', ?)`, [now]);
  run(db, `INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls) VALUES(1, '2026-10-14T08:00:00Z', '2026-10-14T08:05:00Z', 'api', 'done', 1, 1)`);
  run(
    db,
    `INSERT INTO responses(
      id, run_id, prompt_id, provider, surface, model, sample_idx, text, created_at,
      lane, target_status, comparability_status, answer_status, web_status,
      analysis_revision, comparison_key, search_policy
    ) VALUES(1, 1, 1, 'openai', 'openai-api', 'gpt-5.6-luna', 0, 'Use CompX.', '2026-10-14T08:01:00Z',
      'tracking', 'completed', 'comparable', 'complete', 'verified', 'stance-v1', 'cmp-1', 'required')`,
  );
  const mid = Number(
    run(db, `INSERT INTO mentions(response_id, entity_id, first_index, occurrences, recommended, snippet, rank) VALUES(1, 2, 4, 1, 1, 'Use CompX', 1)`).lastInsertRowid,
  );
  storeInterpretation(
    db,
    mid,
    'stance-v1',
    /** @type {*} */ ({ stance: 'positive', rule_id: 'r1', evidence_start: 0, evidence_end: 9, review_flags: [] }),
    '2026-10-14T08:01:00Z',
  );
  run(
    db,
    `INSERT INTO answer_citations(response_id, url, provenance, ordinal) VALUES(1, 'https://single-wave.example/guide', 'native_annotation', 0)`,
  );

  const report = buildClientReport(db, { days: 30, now });
  const html = renderClientReportHtml(report);
  assert.match(html, /single_wave_unverified/);
  assert.match(html, /Only 1 completed measurement wave observed/);

  // Legacy report object (missing v2 fields: forensics, volatility, whiteLabel, citationRate) must render cleanly
  const legacyReport = /** @type {*} */ ({
    generatedAt: now,
    demo: false,
    days: 30,
    window: { start: '2026-09-15T12:00:00Z', end: now },
    brand: { id: 1, name: 'LegacyCo', aliases: [], domains: [] },
    competitors: [],
    series: null,
    kpis: {
      mentionRate: null,
      recommendationRate: null,
      recommendationMethod: 'stance',
      brandSov: null,
      brandMentions: 0,
      totalEntityMentions: 0,
    },
    leaderboard: [],
    intents: [],
    providers: [],
    citationGaps: [],
    receipts: [],
    totalComparableReceipts: 0,
    interventions: [],
    outcomes: [],
    ledger: [],
  });
  const legacyHtml = renderClientReportHtml(legacyReport);
  assert.match(legacyHtml, /LegacyCo/);
  assert.match(legacyHtml, /Why Live Chat on Your Phone May Differ/);
});
