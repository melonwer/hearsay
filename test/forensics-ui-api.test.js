import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import * as realClientExport from '../core/client-export.js';
import { isoNow, run } from '../core/db.js';
import { parseEnvFile } from '../core/env-file.js';
import { storeInterpretation } from '../core/interpretations.js';
import { startServer } from '../server.js';

/**
 * Boot an isolated Hearsay HTTP server with temp DB, temp `.env`, and optional DI overrides.
 *
 * @param {import('node:test').TestContext} t
 * @param {Object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Parameters<typeof startServer>[0]['siteCheck']} [opts.siteCheck]
 * @param {Parameters<typeof startServer>[0]['dataforseoHealth']} [opts.dataforseoHealth]
 * @param {Parameters<typeof startServer>[0]['clientExport']} [opts.clientExport]
 */
async function bootIsolated(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-w2-ui-api-'));
  const envFile = join(dir, '.env');
  const realDbPath = join(dir, 'data/hearsay.db');
  const demoDbPath = join(dir, 'data/demo/hearsay.db');
  mkdirSync(join(dir, 'data'), { recursive: true });

  const mergedEnv = {
    HEARSAY_DB_PATH: realDbPath,
    HEARSAY_DEMO_DB_PATH: demoDbPath,
    ...(opts.env ?? {}),
  };
  const config = buildConfig(mergedEnv);
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: config.dbPath,
    portFile: join(dir, 'hearsay.port'),
    envFile,
    env: mergedEnv,
    config,
    siteCheck: opts.siteCheck,
    dataforseoHealth: opts.dataforseoHealth,
    clientExport: opts.clientExport,
    log: () => {},
  });

  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    app,
    dir,
    envFile,
    base: `http://127.0.0.1:${app.port}`,
  };
}

/**
 * Seed a rich multi-wave forensics dataset covering:
 * - Retrieval attrition (brand dropped, third-party dropped, cited)
 * - Own-site hijack (brand URL cited while competitor positively recommended)
 * - Memory vs. grounded paired prompts (memory_anchored, search_dependent, memory_displaced)
 * - Unpaired (provider, model) group
 * - Multi-wave citation persistence (durable 3/3, recurring 2/3, ephemeral 1/3)
 * - Hostile XSS strings in prompt text / competitor name / URLs
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedForensicsDataset(db) {
  const now = new Date();
  const ts = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Entities: brand + competitor (with XSS payload in competitor name to verify strict escaping)
  const brandId = Number(
    run(
      db,
      `INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 1, ?)`,
      ['AcmeDocs', JSON.stringify(['AcmeDocs']), JSON.stringify(['acmedocs.io']), ts(96)],
    ).lastInsertRowid,
  );
  const compName = 'RivalCo <script>alert("xss-comp")</script>';
  const compId = Number(
    run(
      db,
      `INSERT INTO entities(name, aliases, domains, is_self, created_at) VALUES(?, ?, ?, 0, ?)`,
      [compName, JSON.stringify(['RivalCo']), JSON.stringify(['rivalco.io']), ts(96)],
    ).lastInsertRowid,
  );

  const intentId = Number(
    run(db, `INSERT INTO intents(label, created_at) VALUES(?, ?)`, ['Best docs platform', ts(96)]).lastInsertRowid,
  );

  // 3 prompts for paired memory vs grounded classifications:
  // p1: memory_anchored (in both memory & grounded)
  // p2: search_dependent (absent in memory, present in grounded)
  // p3: memory_displaced (present in memory, absent in grounded — also our hijack prompt!)
  const p1 = Number(
    run(
      db,
      `INSERT INTO prompts(intent_id, text, category, active, created_at, tracking_state, origin, approved_at)
       VALUES(?, ?, 'general', 1, ?, 'tracking', 'user_authored', ?)`,
      [intentId, 'Best docs tool for APIs <img src=x onerror=alert(1)>', ts(96), ts(96)],
    ).lastInsertRowid,
  );
  const p2 = Number(
    run(
      db,
      `INSERT INTO prompts(intent_id, text, category, active, created_at, tracking_state, origin, approved_at)
       VALUES(?, ?, 'general', 1, ?, 'tracking', 'user_authored', ?)`,
      [intentId, 'Hosted API reference platforms with OpenAPI sync', ts(96), ts(96)],
    ).lastInsertRowid,
  );
  const p3 = Number(
    run(
      db,
      `INSERT INTO prompts(intent_id, text, category, active, created_at, tracking_state, origin, approved_at)
       VALUES(?, ?, 'comparison', 1, ?, 'tracking', 'user_authored', ?)`,
      [intentId, 'Compare developer portal pricing and search', ts(96), ts(96)],
    ).lastInsertRowid,
  );

  const rev = 'stance-v1';

  /**
   * @param {{runId:number,promptId:number,provider:string,model:string,surface:string,
   *   searchPolicy:string,webStatus:string,comparisonKey:string,execProfile:string,
   *   text:string,createdAt:string,costUsd?:number}} r
   */
  const addResponse = (r) =>
    Number(
      run(
        db,
        `INSERT INTO responses(
          run_id, prompt_id, provider, model, sample_idx, text, latency_ms, cost_usd, created_at,
          surface, lane, target_status, comparability_status, web_status, query_metadata_status,
          answer_status, execution_profile_id, benchmark_revision_id, analysis_revision,
          comparison_key, search_policy
        ) VALUES(?, ?, ?, ?, 0, ?, 120, ?, ?, ?, 'tracking', 'completed', 'comparable', ?, 'available', 'complete', NULL, NULL, ?, ?, ?)`,
        [
          r.runId,
          r.promptId,
          r.provider,
          r.model,
          r.text,
          r.costUsd ?? 0.05,
          r.createdAt,
          r.surface,
          r.webStatus,
          rev,
          r.comparisonKey,
          r.searchPolicy,
        ],
      ).lastInsertRowid,
    );

  /** @param {number} responseId @param {number} entityId @param {'positive'|'neutral'|'negative'} stance */
  const addMention = (responseId, entityId, stance) => {
    const mId = Number(
      run(
        db,
        `INSERT INTO mentions(response_id, entity_id, first_index, rank, recommended, snippet) VALUES(?, ?, 0, 1, ?, 'excerpt')`,
        [responseId, entityId, stance === 'positive' ? 1 : 0],
      ).lastInsertRowid,
    );
    storeInterpretation(
      db,
      mId,
      rev,
      {
        stance,
        rule_id: 'test-rule',
        evidence_start: 0,
        evidence_end: 10,
        review_flags: [],
      },
      ts(1),
    );
  };

  // Wave 1, Wave 2, Wave 3: grounded OpenAI runs (`search_policy='required'`, `web_status='verified'`)
  const waveIds = [];
  for (let w = 0; w < 3; w += 1) {
    const startAt = ts(48 - w * 12);
    const finAt = ts(47 - w * 12);
    const runId = Number(
      run(
        db,
        `INSERT INTO runs(started_at, finished_at, trigger, status, total_calls, done_calls)
         VALUES(?, ?, 'api', 'done', 3, 3)`,
        [startAt, finAt],
      ).lastInsertRowid,
    );
    waveIds.push(runId);

    // Prompt 1: AcmeDocs mentioned (positive); brand URL retrieved & dropped; durable third-party URL cited (3/3 waves)
    const r1 = addResponse({
      runId,
      promptId: p1,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      surface: 'openai-api',
      searchPolicy: 'required',
      webStatus: 'verified',
      comparisonKey: 'cmp:grounded',
      execProfile: 'prof:grounded',
      text: 'AcmeDocs is great for API docs.',
      createdAt: startAt,
    });
    addMention(r1, brandId, 'positive');
    run(
      db,
      `INSERT INTO source_observations(response_id, url, normalized_url, provenance) VALUES(?, ?, ?, 'search_result')`,
      [r1, 'https://acmedocs.io/guides/dropped-page', 'https://acmedocs.io/guides/dropped-page'],
    );
    run(
      db,
      `INSERT INTO source_observations(response_id, url, normalized_url, provenance) VALUES(?, ?, ?, 'search_result')`,
      [r1, 'https://thirdparty-dropped.org/article', 'https://thirdparty-dropped.org/article'],
    );
    const srcDurable = Number(
      run(
        db,
        `INSERT INTO source_observations(response_id, url, normalized_url, provenance) VALUES(?, ?, ?, 'search_result')`,
        [r1, 'https://durable-review.com/best-docs', 'https://durable-review.com/best-docs'],
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO answer_citations(response_id, source_observation_id, url, provenance, ordinal)
       VALUES(?, ?, ?, 'native_annotation', 1)`,
      [r1, srcDurable, 'https://durable-review.com/best-docs'],
    );

    // Prompt 2: search_dependent (brand mentioned in grounded, absent in memory)
    const r2 = addResponse({
      runId,
      promptId: p2,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      surface: 'openai-api',
      searchPolicy: 'required',
      webStatus: 'verified',
      comparisonKey: 'cmp:grounded',
      execProfile: 'prof:grounded',
      text: 'AcmeDocs supports OpenAPI sync.',
      createdAt: startAt,
    });
    addMention(r2, brandId, 'positive');

    // Prompt 3: memory_displaced & OWN-SITE HIJACK!
    // Brand URL is cited, RivalCo is positively recommended, brand is absent (neutral/absent).
    // Also cites durable-review.com (3/3 waves, brand absent, competitor positive -> top off-site target),
    // recurring-blog.net in waves 0 & 1 (2/3 waves), and ephemeral-post.io in wave 0 only (1/3 waves).
    const r3 = addResponse({
      runId,
      promptId: p3,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      surface: 'openai-api',
      searchPolicy: 'required',
      webStatus: 'verified',
      comparisonKey: 'cmp:grounded',
      execProfile: 'prof:grounded',
      text: 'RivalCo is the top recommendation for developer portal pricing.',
      createdAt: startAt,
    });
    addMention(r3, compId, 'positive');
    const brandSrc = Number(
      run(
        db,
        `INSERT INTO source_observations(response_id, url, normalized_url, provenance) VALUES(?, ?, ?, 'search_result')`,
        [r3, 'https://acmedocs.io/pricing', 'https://acmedocs.io/pricing'],
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO answer_citations(response_id, source_observation_id, url, provenance, ordinal)
       VALUES(?, ?, ?, 'native_annotation', 1)`,
      [r3, brandSrc, 'https://acmedocs.io/pricing'],
    );
    run(
      db,
      `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
       VALUES(?, ?, 'native_annotation', 2)`,
      [r3, 'https://durable-review.com/best-docs'],
    );
    if (w < 2) {
      run(
        db,
        `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
         VALUES(?, ?, 'native_annotation', 3)`,
        [r3, 'https://recurring-blog.net/portal-guide'],
      );
    }
    if (w === 0) {
      run(
        db,
        `INSERT INTO answer_citations(response_id, url, provenance, ordinal)
         VALUES(?, ?, 'native_annotation', 4)`,
        [r3, 'https://ephemeral-post.io/once'],
      );
    }
  }

  // Wave 4: Parametric memory run (`search_policy='off'`, `web_status='not_used'`)
  // Pairs with grounded openai/gpt-5.6-luna on p1, p2, p3 AND adds an unpaired anthropic/claude-sonnet-5!
  const memRunId = Number(
    run(
      db,
      `INSERT INTO runs(started_at, finished_at, trigger, status, total_calls, done_calls)
       VALUES(?, ?, 'api', 'done', 4, 4)`,
      [ts(6), ts(5)],
    ).lastInsertRowid,
  );
  // p1: mentioned in memory -> memory_anchored
  const m1 = addResponse({
    runId: memRunId,
    promptId: p1,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    surface: 'openai-api',
    searchPolicy: 'off',
    webStatus: 'not_used',
    comparisonKey: 'cmp:memory',
    execProfile: 'prof:memory',
    text: 'AcmeDocs is a known API docs tool.',
    createdAt: ts(6),
  });
  addMention(m1, brandId, 'positive');

  // p2: NOT mentioned in memory -> search_dependent
  addResponse({
    runId: memRunId,
    promptId: p2,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    surface: 'openai-api',
    searchPolicy: 'off',
    webStatus: 'not_used',
    comparisonKey: 'cmp:memory',
    execProfile: 'prof:memory',
    text: 'Several hosted OpenAPI portals exist.',
    createdAt: ts(6),
  });

  // p3: mentioned in memory, absent in grounded -> memory_displaced
  const m3 = addResponse({
    runId: memRunId,
    promptId: p3,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    surface: 'openai-api',
    searchPolicy: 'off',
    webStatus: 'not_used',
    comparisonKey: 'cmp:memory',
    execProfile: 'prof:memory',
    text: 'AcmeDocs has transparent portal pricing.',
    createdAt: ts(6),
  });
  addMention(m3, brandId, 'positive');

  // Unpaired model: anthropic/claude-sonnet-5 memory_only
  addResponse({
    runId: memRunId,
    promptId: p1,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    surface: 'anthropic-api',
    searchPolicy: 'off',
    webStatus: 'not_used',
    comparisonKey: 'cmp:anth-mem',
    execProfile: 'prof:anth-mem',
    text: 'AcmeDocs is popular.',
    createdAt: ts(6),
  });

  // Seeded run (`trigger = 'seed'`) to verify default include_seeded=false exclusion
  const seedRunId = Number(
    run(
      db,
      `INSERT INTO runs(started_at, finished_at, trigger, status, total_calls, done_calls)
       VALUES(?, ?, 'seed', 'done', 1, 1)`,
      [ts(4), ts(3)],
    ).lastInsertRowid,
  );
  const seedRespId = addResponse({
    runId: seedRunId,
    promptId: p1,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    surface: 'openai-api',
    searchPolicy: 'required',
    webStatus: 'verified',
    comparisonKey: 'cmp:grounded',
    execProfile: 'prof:grounded',
    text: 'Seeded response',
    createdAt: ts(4),
    costUsd: 99.99,
  });
  run(
    db,
    `INSERT INTO source_observations(response_id, url, normalized_url, provenance) VALUES(?, ?, ?, 'search_result')`,
    [seedRespId, 'https://seeded-only.example/page', 'https://seeded-only.example/page'],
  );

  return { brandId, compId, compName, intentId, p1, p2, p3, waveIds, memRunId, seedRunId };
}

test('POST /api/site-check enforces SSRF guard by default, validates inputs, and succeeds via test DI', async (t) => {
  // 1. Default server (no allowPrivateHosts DI) must block loopback/private targets even if client sends allowPrivateHosts: true
  const defaultCtx = await bootIsolated(t);

  for (const blockedUrl of [
    'http://127.0.0.1:8080/secret',
    'http://localhost:3000/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    const res = await fetch(`${defaultCtx.base}/api/site-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: defaultCtx.base },
      body: JSON.stringify({ url: blockedUrl, allowPrivateHosts: true }),
    });
    assert.equal(res.status, 403, `${blockedUrl} must be blocked with 403`);
    const body = await res.json();
    assert.equal(body.error.code, 'ssrf_blocked');
  }

  // Invalid URL & invalid timeoutMs -> 422
  const badUrlRes = await fetch(`${defaultCtx.base}/api/site-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: defaultCtx.base },
    body: JSON.stringify({ url: 'ftp://example.com/file' }),
  });
  assert.equal(badUrlRes.status, 422);
  assert.equal((await badUrlRes.json()).error.code, 'invalid_url');

  const badTimeoutRes = await fetch(`${defaultCtx.base}/api/site-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: defaultCtx.base },
    body: JSON.stringify({ url: 'https://example.com', timeoutMs: 50 }),
  });
  assert.equal(badTimeoutRes.status, 422);

  // Cross-origin and proxy-forwarded requests -> 403
  const crossOrigin = await fetch(`${defaultCtx.base}/api/site-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(crossOrigin.status, 403);

  const proxied = await fetch(`${defaultCtx.base}/api/site-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.5' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(proxied.status, 403);

  // 2. Ephemeral local fixture site + test DI (`allowPrivateHosts: true`)
  const targetServer = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Audit &lt;script&gt;alert(1)&lt;/script&gt;</title></head>' +
        '<body><h1>Hello Pre-Flight <script>alert("title-xss")</script></h1>' +
        '<p>This is a substantive paragraph with more than eighty characters of clean server-rendered HTML content for AI crawlers.</p>' +
        '</body></html>',
    );
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise((resolve) => targetServer.close(() => resolve(undefined))));
  const targetPort = /** @type {import('node:net').AddressInfo} */ (targetServer.address()).port;

  const diCtx = await bootIsolated(t, {
    siteCheck: { allowPrivateHosts: true },
  });

  const okRes = await fetch(`${diCtx.base}/api/site-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: diCtx.base },
    body: JSON.stringify({ url: `http://127.0.0.1:${targetPort}/`, browser: false, timeoutMs: 5000 }),
  });
  assert.equal(okRes.status, 200);
  const receipt = await okRes.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 200);
  assert.equal(typeof receipt.text, 'string');
  assert.match(receipt.text, /Hearsay Site Pre-Flight Check/);
  assert.equal(receipt.robotsTxt.crawlers.find((c) => c.bot === 'GPTBot')?.allowed, false);
  assert.equal(receipt.robotsTxt.crawlers.find((c) => c.bot === 'OAI-SearchBot')?.allowed, true);

  // Settings page displays the latest pre-flight receipt cleanly and escapes hostile markup.
  const settingsHtml = await fetch(`${diCtx.base}/settings`).then((r) => r.text());
  assert.match(settingsHtml, /Latest pre-flight receipt/);
  assert.equal(settingsHtml.includes('<script>alert('), false);
});

test('forensics API endpoints return attrition, hijacks, memory-vs-search delta, and persistence with filter validation', async (t) => {
  const ctx = await bootIsolated(t);
  const seeded = seedForensicsDataset(ctx.app.db);

  // 1. GET /api/forensics/attrition (excludes seeded by default)
  const attrRes = await fetch(`${ctx.base}/api/forensics/attrition?surface=openai-api&provider=openai&model=gpt-5.6-luna`);
  assert.equal(attrRes.status, 200);
  const attr = await attrRes.json();
  assert.equal(attr.n, 9, '3 waves x 3 grounded prompts, seeded excluded');
  assert.ok(attr.droppedObservations > 0);
  assert.equal(attr.topDroppedBrandUrls[0].url, 'https://acmedocs.io/guides/dropped-page');
  assert.equal(attr.topDroppedThirdPartyUrls[0].url, 'https://thirdparty-dropped.org/article');
  assert.equal(
    attr.topDroppedThirdPartyUrls.some((u) => u.url.includes('seeded-only.example')),
    false,
    'seeded run must be excluded when include_seeded is not set',
  );
  assert.equal(attr.hijacks.count, 3, 'all 3 waves had own-site hijack on p3');
  assert.equal(attr.hijacks.receipts[0].ownCitedUrls[0], 'https://acmedocs.io/pricing');

  // With include_seeded=1
  const attrSeeded = await fetch(`${ctx.base}/api/forensics/attrition?include_seeded=1`).then((r) => r.json());
  assert.equal(attrSeeded.n, 10);
  assert.equal(
    attrSeeded.topDroppedThirdPartyUrls.some((u) => u.url.includes('seeded-only.example')),
    true,
  );

  // Run-scoped filter
  const attrOneRun = await fetch(`${ctx.base}/api/forensics/attrition?run_id=${seeded.waveIds[0]}`).then((r) => r.json());
  assert.equal(attrOneRun.n, 3);

  // Invalid query params -> 400
  const badPolicy = await fetch(`${ctx.base}/api/forensics/attrition?search_policy=bogus`);
  assert.equal(badPolicy.status, 400);
  const badRunId = await fetch(`${ctx.base}/api/forensics/attrition?run_id=-1`);
  assert.equal(badRunId.status, 400);
  const badSeeded = await fetch(`${ctx.base}/api/forensics/attrition?include_seeded=maybe`);
  assert.equal(badSeeded.status, 400);

  // 2. GET /api/forensics/memory-vs-search
  const deltaRes = await fetch(`${ctx.base}/api/forensics/memory-vs-search`);
  assert.equal(deltaRes.status, 200);
  const delta = await deltaRes.json();
  assert.equal(delta.summary.pairedModels, 1);
  assert.equal(delta.summary.unpairedModels, 1);
  const openaiPair = delta.pairs.find((p) => p.provider === 'openai' && p.model === 'gpt-5.6-luna');
  assert.ok(openaiPair);
  assert.equal(openaiPair.status, 'paired');
  assert.equal(openaiPair.pairedPromptCount, 3);
  assert.equal(openaiPair.classificationSummary.memory_anchored, 1);
  assert.equal(openaiPair.classificationSummary.search_dependent, 1);
  assert.equal(openaiPair.classificationSummary.memory_displaced, 1);
  const anthPair = delta.pairs.find((p) => p.provider === 'anthropic');
  assert.equal(anthPair.status, 'memory_only');

  // 3. GET /api/forensics/persistence
  const persRes = await fetch(`${ctx.base}/api/forensics/persistence?surface=openai-api`);
  assert.equal(persRes.status, 200);
  const pers = await persRes.json();
  assert.equal(pers.totalWaves, 4, '3 grounded waves + 1 memory wave');
  const durable = pers.offSiteTargets.find((u) => u.url === 'https://durable-review.com/best-docs');
  assert.ok(durable);
  assert.equal(durable.tier, 'durable');
  assert.equal(durable.wavesSeen, 3);
  const recurring = pers.offSiteTargets.find((u) => u.url === 'https://recurring-blog.net/portal-guide');
  assert.equal(recurring.tier, 'recurring');
  const ephemeral = pers.offSiteTargets.find((u) => u.url === 'https://ephemeral-post.io/once');
  assert.equal(ephemeral.tier, 'ephemeral');
  assert.ok(pers.summary.offSiteShare > 0);

  // Single-wave honesty via run_id filter
  const singleWave = await fetch(`${ctx.base}/api/forensics/persistence?run_id=${seeded.waveIds[0]}`).then((r) => r.json());
  assert.equal(singleWave.totalWaves, 1);
  assert.equal(singleWave.urls.every((u) => u.tier === 'single_wave_unverified'), true);
});

test('GET /api/spend-cap reports live current-month UTC spend and enforces cap status', async (t) => {
  const ctx = await bootIsolated(t, {
    env: { HEARSAY_MONTHLY_USD_CAP: '1.00' },
  });

  const nowIso = isoNow();
  const prevMonthDate = new Date();
  prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 2);
  const prevMonthIso = prevMonthDate.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const intentId = Number(run(ctx.app.db, `INSERT INTO intents(label, created_at) VALUES('i', ?)`, [nowIso]).lastInsertRowid);
  const promptId = Number(
    run(
      ctx.app.db,
      `INSERT INTO prompts(intent_id, text, category, active, created_at) VALUES(?, 'q', 'general', 1, ?)`,
      [intentId, nowIso],
    ).lastInsertRowid,
  );
  const liveRunId = Number(
    run(ctx.app.db, `INSERT INTO runs(started_at, finished_at, trigger, status) VALUES(?, ?, 'api', 'done')`, [nowIso, nowIso]).lastInsertRowid,
  );
  const seedRunId = Number(
    run(ctx.app.db, `INSERT INTO runs(started_at, finished_at, trigger, status) VALUES(?, ?, 'seed', 'done')`, [nowIso, nowIso]).lastInsertRowid,
  );

  // Current month live: $0.40
  run(
    ctx.app.db,
    `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, cost_usd, created_at)
     VALUES(?, ?, 'openai', 'gpt-5.6-luna', 1, 'ok', 0.40, ?)`,
    [liveRunId, promptId, nowIso],
  );
  // Seeded: $50.00 (excluded!)
  run(
    ctx.app.db,
    `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, cost_usd, created_at)
     VALUES(?, ?, 'openai', 'gpt-5.6-luna', 2, 'seed', 50.00, ?)`,
    [seedRunId, promptId, nowIso],
  );
  // Prior month live: $20.00 (excluded!)
  run(
    ctx.app.db,
    `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, cost_usd, created_at)
     VALUES(?, ?, 'openai', 'gpt-5.6-luna', 3, 'old', 20.00, ?)`,
    [liveRunId, promptId, prevMonthIso],
  );

  const underRes = await fetch(`${ctx.base}/api/spend-cap`);
  assert.equal(underRes.status, 200);
  const under = await underRes.json();
  assert.equal(under.allowed, true);
  assert.equal(under.reason, null);
  assert.ok(Math.abs(under.spentUsd - 0.4) < 1e-6);
  assert.equal(under.capUsd, 1);
  assert.equal(under.monthlyUsdCap, 1);
  assert.ok(Math.abs(under.remainingUsd - 0.6) < 1e-6);
  assert.ok(Math.abs(under.utilizationPct - 40) < 1e-6);

  // Push current-month live spend over $1.00
  run(
    ctx.app.db,
    `INSERT INTO responses(run_id, prompt_id, provider, model, sample_idx, text, cost_usd, created_at)
     VALUES(?, ?, 'openai', 'gpt-5.6-luna', 4, 'ok2', 0.75, ?)`,
    [liveRunId, promptId, nowIso],
  );
  const over = await fetch(`${ctx.base}/api/spend-cap`).then((r) => r.json());
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'spend_cap_exceeded');
  assert.ok(Math.abs(over.spentUsd - 1.15) < 1e-6);
  assert.equal(over.remainingUsd, 0);
});

test('POST /api/dataforseo/health checks configured mode, validates mode, and scrubs credentials everywhere', async (t) => {
  const login = 'analyst@secret-agency.example';
  const password = 'dfs-ultra-secret-pass-987654';
  const basicToken = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');

  /** @type {any[]} */
  const calls = [];
  const ctx = await bootIsolated(t, {
    env: {
      DATAFORSEO_LOGIN: login,
      DATAFORSEO_PASSWORD: password,
      HEARSAY_LOCATION_CODE: '2826',
      HEARSAY_LANGUAGE_CODE: 'en',
    },
    dataforseoHealth: async (opts) => {
      calls.push(opts);
      if (opts.mode === 'chatgpt-web') {
        return {
          ok: false,
          mode: 'chatgpt-web',
          statusCode: 40100,
          latencyMs: 88,
          costUsd: null,
          error: `Auth failed for ${login} with ${password} header Basic ${basicToken}`,
        };
      }
      return {
        ok: true,
        mode: 'google-aio',
        statusCode: 200,
        latencyMs: 142,
        costUsd: 0.002,
        error: null,
      };
    },
  });

  // Invalid mode -> 422
  const badMode = await fetch(`${ctx.base}/api/dataforseo/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ mode: 'perplexity-scrape' }),
  });
  assert.equal(badMode.status, 422);

  // Valid google-aio canary
  const okRes = await fetch(`${ctx.base}/api/dataforseo/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ mode: 'google-aio' }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.mode, 'google-aio');
  assert.equal(okBody.statusCode, 200);
  assert.equal(okBody.costUsd, 0.002);
  assert.equal(calls[0].login, login);
  assert.equal(calls[0].password, password);
  assert.equal(calls[0].locationCode, 2826);

  // Failed chatgpt-web canary whose raw error attempts to echo credentials -> MUST be scrubbed!
  const failRes = await fetch(`${ctx.base}/api/dataforseo/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ mode: 'chatgpt-web' }),
  });
  assert.equal(failRes.status, 200);
  const failRaw = await failRes.text();
  const failBody = JSON.parse(failRaw);
  assert.equal(failBody.ok, false);
  assert.equal(failBody.mode, 'chatgpt-web');
  for (const secret of [login, password, password.slice(-6), basicToken]) {
    assert.equal(failRaw.includes(secret), false, `Health response must not leak ${secret}`);
  }

  // Settings HTML must also never leak password or Basic token
  const settingsHtml = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  assert.match(settingsHtml, /Last canary status/);
  for (const secret of [password, password.slice(-6), basicToken]) {
    assert.equal(settingsHtml.includes(secret), false, `Settings HTML must not leak ${secret}`);
  }
});

test('GET /api/export/report validates and forwards white-label options cleanly', async (t) => {
  /** @type {{buildOpts?: any, renderOpts?: any}} */
  const captured = {};
  const ctx = await bootIsolated(t, {
    clientExport: {
      ...realClientExport,
      buildClientReport: (db, opts) => {
        captured.buildOpts = opts;
        return realClientExport.buildClientReport(db, opts);
      },
      renderClientReportHtml: (report, opts) => {
        captured.renderOpts = opts;
        return realClientExport.renderClientReportHtml(report);
      },
    },
  });

  // Invalid accent_color (CSS injection) -> 400
  for (const badColor of ['red', '#fff;background:url(evil)', 'javascript:alert(1)', '#12']) {
    const res = await fetch(
      `${ctx.base}/api/export/report?accent_color=${encodeURIComponent(badColor)}`,
    );
    assert.equal(res.status, 400, `accent_color=${badColor} must be rejected with 400`);
  }

  // Valid white-label query params forwarded as { brandLabel, accentColor, footerNote }
  const res = await fetch(
    `${ctx.base}/api/export/report?inline=1&brand_label=${encodeURIComponent('Northstar SEO')}&accent_color=${encodeURIComponent('#2a78d6')}&footer_note=${encodeURIComponent('Prepared for Acme')}`,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-disposition') ?? '', /^inline;/);
  const body = await res.text();
  assert.match(body, /<!doctype html>/i);

  assert.equal(captured.buildOpts?.brandLabel, 'Northstar SEO');
  assert.equal(captured.buildOpts?.accentColor, '#2a78d6');
  assert.equal(captured.buildOpts?.footerNote, 'Prepared for Acme');
  assert.deepEqual(captured.renderOpts, {
    brandLabel: 'Northstar SEO',
    accentColor: '#2a78d6',
    footerNote: 'Prepared for Acme',
  });
});

test('GET/POST /api/settings round-trips all 8 .env settings with 0600 perms and zero secret leaks', async (t) => {
  const ctx = await bootIsolated(t);
  const secretLogin = 'seo-ops@acmedocs.example';
  const secretPass = 'dfs-top-secret-password-774411';

  // Initial state: unconfigured
  const beforeRes = await fetch(`${ctx.base}/api/settings`);
  assert.equal(beforeRes.status, 200);
  const before = await beforeRes.json();
  assert.equal(before.dataforseo.configured, false);
  assert.equal(before.env.DATAFORSEO_PASSWORD.configured, false);
  assert.equal(before.geolocation.locationCode, null);
  assert.equal(before.spendCap.capUsd, null);
  assert.equal(before.allowUnverifiedModels, false);

  // Save all 8 env settings via POST /api/settings
  const saveRes = await fetch(`${ctx.base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      DATAFORSEO_LOGIN: secretLogin,
      DATAFORSEO_PASSWORD: secretPass,
      HEARSAY_LOCATION_CODE: '2840',
      HEARSAY_LOCATION_COUNTRY: 'us',
      HEARSAY_LOCATION_CITY: 'Austin <script>alert("city-xss")</script>',
      HEARSAY_LANGUAGE_CODE: 'en-US',
      HEARSAY_MONTHLY_USD_CAP: '42.50',
      HEARSAY_ALLOW_UNVERIFIED_MODELS: true,
    }),
  });
  assert.equal(saveRes.status, 200);
  const saveRaw = await saveRes.text();
  const saved = JSON.parse(saveRaw);
  assert.equal(saved.ok, true);
  assert.equal(saved.dataforseo.configured, true);
  assert.equal(saved.dataforseo.loginConfigured, true);
  assert.equal(saved.dataforseo.passwordConfigured, true);
  assert.equal(saved.env.DATAFORSEO_LOGIN.configured, true);
  assert.equal(saved.env.DATAFORSEO_PASSWORD.configured, true);
  assert.equal('value' in saved.env.DATAFORSEO_PASSWORD, false, 'password env entry must never have a value field');
  assert.equal(saved.geolocation.locationCode, 2840);
  assert.equal(saved.geolocation.locationCountry, 'US');
  assert.equal(saved.geolocation.locationCity, 'Austin <script>alert("city-xss")</script>');
  assert.equal(saved.geolocation.languageCode, 'en-US');
  assert.equal(saved.spendCap.capUsd, 42.5);
  assert.equal(saved.allowUnverifiedModels, true);

  // Verify `.env` on disk has strict 0600 permissions and exact values
  assert.ok(existsSync(ctx.envFile));
  assert.equal(statSync(ctx.envFile).mode & 0o777, 0o600);
  const onDisk = parseEnvFile(readFileSync(ctx.envFile, 'utf8'));
  assert.equal(onDisk.DATAFORSEO_LOGIN, secretLogin);
  assert.equal(onDisk.DATAFORSEO_PASSWORD, secretPass);
  assert.equal(onDisk.HEARSAY_LOCATION_CODE, '2840');
  assert.equal(onDisk.HEARSAY_LOCATION_COUNTRY, 'US');
  assert.equal(onDisk.HEARSAY_LANGUAGE_CODE, 'en-US');
  assert.equal(onDisk.HEARSAY_MONTHLY_USD_CAP, '42.5');
  assert.equal(onDisk.HEARSAY_ALLOW_UNVERIFIED_MODELS, '1');

  // Verify ZERO raw password or suffix leaks across GET /api/settings, POST /api/settings, GET /settings, GET /api/status
  const getSettingsRaw = await fetch(`${ctx.base}/api/settings`).then((r) => r.text());
  const settingsHtml = await fetch(`${ctx.base}/settings`).then((r) => r.text());
  const statusRaw = await fetch(`${ctx.base}/api/status`).then((r) => r.text());
  for (const [label, payload] of [
    ['POST /api/settings', saveRaw],
    ['GET /api/settings', getSettingsRaw],
    ['GET /settings', settingsHtml],
    ['GET /api/status', statusRaw],
  ]) {
    assert.equal(payload.includes(secretPass), false, `${label} leaked full DATAFORSEO_PASSWORD`);
    assert.equal(payload.includes(secretPass.slice(-6)), false, `${label} leaked DATAFORSEO_PASSWORD suffix`);
  }

  // Settings HTML escapes hostile city XSS payload and renders all 5 new control sections
  assert.equal(settingsHtml.includes('<script>alert("city-xss")</script>'), false);
  assert.match(settingsHtml, /Austin &lt;script&gt;alert\(&quot;city-xss&quot;\)&lt;\/script&gt;/);
  assert.match(settingsHtml, /Site Pre-Flight Check/);
  assert.match(settingsHtml, /BYOK DataForSEO/);
  assert.match(settingsHtml, /Geolocation/);
  assert.match(settingsHtml, /Hard Monthly USD Spend Cap/);
  assert.match(settingsHtml, /Unverified Model Opt-In/);
  assert.match(settingsHtml, /role="meter"/);

  // Updating another setting with blank password preserves saved DATAFORSEO_PASSWORD
  const partialRes = await fetch(`${ctx.base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({
      DATAFORSEO_PASSWORD: '',
      HEARSAY_MONTHLY_USD_CAP: '',
      HEARSAY_ALLOW_UNVERIFIED_MODELS: false,
    }),
  });
  assert.equal(partialRes.status, 200);
  const partial = await partialRes.json();
  assert.equal(partial.dataforseo.passwordConfigured, true);
  assert.equal(partial.spendCap.capUsd, null);
  assert.equal(partial.allowUnverifiedModels, false);

  // clearKeys removes DataForSEO credentials cleanly
  const clearedRes = await fetch(`${ctx.base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ clearKeys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] }),
  });
  assert.equal(clearedRes.status, 200);
  const cleared = await clearedRes.json();
  assert.equal(cleared.dataforseo.configured, false);
  assert.equal(cleared.env.DATAFORSEO_PASSWORD.configured, false);

  // Validation errors -> 422 and zero writes
  for (const badBody of [
    { HEARSAY_LOCATION_CODE: 'abc' },
    { HEARSAY_LOCATION_COUNTRY: 'USA' },
    { HEARSAY_MONTHLY_USD_CAP: '-5' },
    { DATAFORSEO_PASSWORD: 'bad\nINJECT=1' },
    { UNKNOWN_SETTING: '1' },
  ]) {
    const r = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify(badBody),
    });
    assert.equal(r.status, 422, `Expected 422 for ${JSON.stringify(badBody)}`);
  }

  // Existing PATCH /api/settings continues working
  const patchRes = await fetch(`${ctx.base}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base },
    body: JSON.stringify({ includeBrandedInSov: true }),
  });
  assert.equal(patchRes.status, 200);
  assert.equal((await patchRes.json()).includeBrandedInSov, true);

  // Non-loopback / proxy headers rejected with 403
  const proxiedGet = await fetch(`${ctx.base}/api/settings`, {
    headers: { 'X-Forwarded-For': '198.51.100.2' },
  });
  assert.equal(proxiedGet.status, 403);
});

test('dashboard pages (/evidence, /opportunities, /settings) render Wave 2 forensics panels with zero XSS', async (t) => {
  const ctx = await bootIsolated(t, {
    env: {
      HEARSAY_MONTHLY_USD_CAP: '25',
      HEARSAY_LOCATION_CODE: '2840',
      HEARSAY_LOCATION_COUNTRY: 'US',
    },
  });
  seedForensicsDataset(ctx.app.db);

  // 1. GET /evidence renders Attrition, Own-Site Hijacks, and Memory vs Search Delta
  const evRes = await fetch(`${ctx.base}/evidence`);
  assert.equal(evRes.status, 200);
  assert.match(evRes.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const evHtml = await evRes.text();
  assert.match(evHtml, /Retrieved-but-Dropped/);
  assert.match(evHtml, /Own-Site Hijacks/);
  assert.match(evHtml, /https:\/\/acmedocs\.io\/guides\/dropped-page/);
  assert.match(evHtml, /https:\/\/thirdparty-dropped\.org\/article/);
  assert.match(evHtml, /https:\/\/acmedocs\.io\/pricing/);
  assert.match(evHtml, /Parametric Memory vs\. Grounded Retrieval Delta/);
  assert.match(evHtml, /memory_anchored/);
  assert.match(evHtml, /search_dependent/);
  assert.match(evHtml, /memory_displaced/);
  assert.match(evHtml, /Unpaired notice:/);
  // Hostile XSS payloads from prompt and competitor name MUST be escaped
  assert.equal(evHtml.includes('<script>alert("xss-comp")</script>'), false);
  assert.equal(evHtml.includes('<img src=x onerror=alert(1)>'), false);
  assert.match(evHtml, /&lt;script&gt;alert\(&quot;xss-comp&quot;\)&lt;\/script&gt;/);

  // Dedicated layer tabs render cleanly
  const attrTab = await fetch(`${ctx.base}/evidence?layer=attrition`).then((r) => r.text());
  assert.match(attrTab, /id="retrieval-attrition"/);
  const memTab = await fetch(`${ctx.base}/evidence?layer=memory_vs_search`).then((r) => r.text());
  assert.match(memTab, /id="memory-vs-search"/);

  // 2. GET /opportunities renders Persistent Off-Site Targets with durability badges and competitor impact
  const oppRes = await fetch(`${ctx.base}/opportunities`);
  assert.equal(oppRes.status, 200);
  const oppHtml = await oppRes.text();
  assert.match(oppHtml, /Persistent Off-Site Targets/);
  assert.match(oppHtml, /durable-review\.com/);
  assert.match(oppHtml, /recurring-blog\.net/);
  assert.match(oppHtml, /ephemeral-post\.io/);
  assert.match(oppHtml, />durable</);
  assert.match(oppHtml, />recurring</);
  assert.match(oppHtml, />ephemeral</);
  assert.match(oppHtml, /Off-site citation share/);
  assert.equal(oppHtml.includes('<script>alert("xss-comp")</script>'), false);

  // 3. GET /settings has strict CSP and zero inline scripts
  const setRes = await fetch(`${ctx.base}/settings`);
  assert.equal(setRes.status, 200);
  assert.match(setRes.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const setHtml = await setRes.text();
  const inlineScriptMatches = setHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/gi);
  assert.equal(inlineScriptMatches, null, 'Settings page must have zero inline <script> tags');
});
