import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, afterEach } from 'node:test';

import { runPrompt } from '../core/providers/gemini.js';
import { parseGeminiGrounding, utf8ByteToStringIndex } from '../core/providers/gemini-grounding.js';
import { _setFetch, ProviderError } from '../core/providers/shared.js';
import { buildConfig } from '../core/config.js';
import { apiExecutionBudget } from '../core/execution-budget.js';
import { executionProfile } from '../core/measurement-contract.js';
import { searchSuggestions } from '../web/gemini-grounding.js';
import { get, openDb, run } from '../core/db.js';
import { storeMeasurementEvidence } from '../core/measurement-storage.js';
import { exportAll } from '../web/queries.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/gemini-grounded.json', import.meta.url), 'utf8'));
afterEach(() => _setFetch());

test('Gemini grounding preserves query, chunk, and support provenance across UTF-8 parts', () => {
  const parts = fixture.candidates[0].content.parts.map((part) => part.text);
  const evidence = parseGeminiGrounding(fixture.candidates[0].groundingMetadata, parts);
  assert.equal(utf8ByteToStringIndex(parts[0], 6), 5);
  assert.equal(utf8ByteToStringIndex(parts[0], 7), null);
  assert.equal(utf8ByteToStringIndex(parts[0], 15), 12);
  assert.deepEqual(evidence.searchActions[0].queries, ['Café awards', 'emoji award winners']);
  assert.deepEqual(evidence.sources.map((source) => [source.id, source.actionId, source.order]), [
    ['grounding-chunk:0', null, 0], ['grounding-chunk:1', null, 1],
  ]);
  assert.deepEqual(evidence.answerCitations.map((citation) =>
    [citation.sourceId, citation.start, citation.end]), [
    ['grounding-chunk:0', 5, 12], ['grounding-chunk:1', 5, 12],
    ['grounding-chunk:1', 14, 18],
  ]);
  assert.deepEqual(evidence.receipt.groundingSupports, fixture.candidates[0].groundingMetadata.groundingSupports);
});

test('invalid support boundaries and indices never attach to a wrong chunk', () => {
  const metadata = structuredClone(fixture.candidates[0].groundingMetadata);
  metadata.groundingSupports = [
    { segment: { startIndex: 6, endIndex: 7 }, groundingChunkIndices: [0] },
    { segment: { startIndex: 6, endIndex: 15, text: 'wrong text' }, groundingChunkIndices: [0] },
    { segment: { startIndex: 6, endIndex: 15, text: '😀 wins' }, groundingChunkIndices: [99, -1, 1] },
  ];
  const evidence = parseGeminiGrounding(metadata, ['Café 😀 wins.']);
  assert.deepEqual(evidence.answerCitations.map((citation) => citation.sourceId), ['grounding-chunk:1']);
  assert.equal(evidence.sources.length, 2);
  assert.deepEqual(evidence.receipt.groundingSupports, metadata.groundingSupports);
});

test('chunk-only and absent metadata keep their distinct evidence states', () => {
  const chunkOnly = parseGeminiGrounding({ groundingChunks: fixture.candidates[0].groundingMetadata.groundingChunks,
    searchEntryPoint: fixture.candidates[0].groundingMetadata.searchEntryPoint }, ['Answer']);
  assert.equal(chunkOnly.sources.length, 2);
  assert.equal(chunkOnly.answerCitations.length, 0);
  assert.equal(chunkOnly.searchActions[0].queryMetadata, 'unavailable');
  const absent = parseGeminiGrounding(null, ['Answer']);
  assert.equal(absent.receipt.status, 'absent');
  assert.deepEqual(absent.searchActions, []);
  assert.equal(absent.observedSearch, false);
});

test('Gemini auto uses the validated GenerateContent search profile and retains unknown search cost units', async () => {
  /** @type {RequestInit|null} */
  let request = null;
  _setFetch(async (_url, init) => {
    request = init;
    return new Response(JSON.stringify(fixture), { status: 200 });
  });
  const result = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto', maxResponseBytes: 2 * 1024 * 1024 });
  const body = JSON.parse(String(request?.body));
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Who won?' }] }]);
  assert.equal(result.text, 'Café 😀 wins. More.');
  assert.equal(result.answerStatus, 'complete');
  assert.deepEqual(result.citations?.map((citation) => citation.url), [
    'https://example.org/cafe',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture',
  ]);
  assert.equal(result.billableAttempts?.[0].searchCalls, null);
  assert.deepEqual(result.tokens, { input: 22, output: 15 });
  assert.equal(result.groundingReceipt?.status, 'present');
  const budget = apiExecutionBudget(buildConfig({ GEMINI_API_KEY: 'fixture-key',
    HEARSAY_GEMINI_SEARCH_POLICY: 'auto' }), 'gemini');
  const offBudget = apiExecutionBudget(buildConfig({ GEMINI_API_KEY: 'fixture-key' }), 'gemini');
  const profile = (selected) => executionProfile({ surface: selected.surface, route: selected.route,
    model: selected.model, searchPolicy: selected.searchPolicy,
    requestSettings: { endpoint: selected.endpoint, enabledTools: selected.enabledTools },
    limits: { maxSearchCalls: selected.maxSearchCalls, maxOutputBytes: selected.maxOutputBytes } });
  assert.notEqual(profile(budget).id, profile(offBudget).id);
  assert.deepEqual([budget.route, budget.searchPolicy, budget.enabledTools, budget.maxSearchCalls,
    budget.searchCallLimitEnforced], [
    'gemini-generate-content-google-search-v1', 'auto', ['google_search'], null, false,
  ]);
  assert.throws(() => apiExecutionBudget(buildConfig({ GEMINI_MODEL: 'unknown-model',
    HEARSAY_GEMINI_SEARCH_POLICY: 'auto' }), 'gemini'), /not validated/);
  assert.throws(() => buildConfig({ HEARSAY_GEMINI_SEARCH_POLICY: 'required' }), /off or auto/);
});

test('grounded answer missing required suggestions fails without exposing grounded content', async () => {
  const response = structuredClone(fixture);
  delete response.candidates[0].groundingMetadata.searchEntryPoint;
  _setFetch(async () => new Response(JSON.stringify(response), { status: 200 }));
  const error = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' }).catch((failure) => failure);
  assert.ok(error instanceof ProviderError);
  assert.match(error.message, /lacks Search Suggestions/);
  assert.equal(error.partialResult, null);
  assert.equal(error.billableAttempts?.[0].inputTokens, 22);
});

test('Gemini grounding capability rejection gives a route and fallback action', async () => {
  _setFetch(async () => new Response(JSON.stringify({ error: { message: 'grounding is unavailable' } }),
    { status: 403 }));
  const error = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' }).catch((failure) => failure);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'auth');
  assert.match(error.toStorage(), /Check grounding access for gemini-3\.6-flash/);
  assert.match(error.toStorage(), /HEARSAY_GEMINI_SEARCH_POLICY=off/);
  assert.doesNotMatch(error.toStorage(), /fixture-key/);
});

test('empty, ungrounded, and HTTP 200 no-candidate responses keep their real states', async () => {
  const response = structuredClone(fixture);
  response.candidates[0].content.parts = [{ text: '' }];
  _setFetch(async () => new Response(JSON.stringify(response), { status: 200 }));
  const empty = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' });
  assert.equal(empty.answerStatus, 'empty');
  assert.equal(empty.searchActions?.[0].status, 'completed');
  assert.deepEqual(empty.answerCitations, []);

  response.candidates[0].content.parts = [{ text: 'No search used.' }];
  delete response.candidates[0].groundingMetadata;
  const ungrounded = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' });
  assert.equal(ungrounded.answerStatus, 'complete');
  assert.deepEqual(ungrounded.searchActions, []);
  assert.equal(ungrounded.groundingReceipt?.status, 'absent');

  response.candidates = [];
  const noCandidate = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' }).catch((failure) => failure);
  assert.ok(noCandidate instanceof ProviderError);
  assert.match(noCandidate.message, /no candidates/);
  assert.equal(noCandidate.billableAttempts?.[0].inputTokens, 22);
});

test('Gemini auto rejects a missing key before any provider request', async () => {
  let requests = 0;
  _setFetch(async () => {
    requests += 1;
    return new Response(JSON.stringify(fixture), { status: 200 });
  });
  const error = await runPrompt('Who won?', { apiKey: '', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' }).catch((failure) => failure);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /GEMINI_API_KEY is not set/);
  assert.equal(requests, 0);
});

test('safety and incomplete finishes cannot enter the comparable answer set', async () => {
  const response = structuredClone(fixture);
  response.candidates[0].finishReason = 'SAFETY';
  _setFetch(async () => new Response(JSON.stringify(response), { status: 200 }));
  const refused = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' });
  assert.equal(refused.answerStatus, 'refused');
  response.candidates[0].finishReason = 'MAX_TOKENS';
  const truncated = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' });
  assert.equal(truncated.answerStatus, 'truncated');
  delete response.candidates[0].finishReason;
  const unknown = await runPrompt('Who won?', { apiKey: 'fixture-key', model: 'gemini-3.6-flash',
    timeoutMs: 1000, searchPolicy: 'auto' });
  assert.equal(unknown.answerStatus, 'incomplete');
});

test('Google Search Suggestions markup stays inside a scriptless opaque frame', () => {
  const receipt = parseGeminiGrounding({
    searchEntryPoint: { renderedContent: '<script>parent.alert(1)</script><a href="https://google.com" target="_blank">Search</a>' },
  }, ['Answer']).receipt;
  const output = String(searchSuggestions(receipt));
  assert.match(output, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(output, /allow-scripts|allow-same-origin/);
  assert.match(output, /srcdoc="&lt;script&gt;parent\.alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(output, /<script>/);
});

test('grounding receipt survives normalized storage and export with source citation edges', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = '2026-09-26T10:00:00Z';
  run(db, 'INSERT INTO intents(id,label,created_at) VALUES(1,?,?)', ['Awards', at]);
  run(db, `INSERT INTO prompts(id,intent_id,text,category,active,created_at)
    VALUES(1,1,'Who won?','discovery',1,?)`, [at]);
  run(db, "INSERT INTO runs(id,started_at,trigger,status) VALUES(1,?,'manual','running')", [at]);
  const responseId = run(db, `INSERT INTO responses(run_id,prompt_id,provider,surface,model,
    sample_idx,created_at,lane,target_status,search_policy)
    VALUES(1,1,'gemini','gemini-api','gemini-3.6-flash',0,?,'tracking','queued','auto')`, [at]).lastInsertRowid;
  const parsed = parseGeminiGrounding(fixture.candidates[0].groundingMetadata,
    fixture.candidates[0].content.parts.map((part) => part.text));
  storeMeasurementEvidence(db, responseId, {
    policy: 'auto', answerStatus: 'complete', answer: 'Café 😀 wins. More.',
    actions: parsed.searchActions, sources: parsed.sources, citations: parsed.answerCitations,
    groundingReceipt: parsed.receipt, usage: [], at,
  });
  assert.equal(get(db, 'SELECT web_status FROM responses WHERE id = ?', [responseId])?.web_status, 'verified');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM search_queries WHERE response_id = ?', [responseId])?.n, 2);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM source_observations WHERE response_id = ?', [responseId])?.n, 2);
  assert.deepEqual({ ...get(db, `SELECT a.answer_start, a.answer_end, s.original_order
    FROM answer_citations a JOIN source_observations s ON s.id = a.source_observation_id
    WHERE a.response_id = ? ORDER BY a.ordinal LIMIT 1`, [responseId]) },
  { answer_start: 5, answer_end: 12, original_order: 0 });
  const exported = exportAll(db);
  const tables = /** @type {Record<string, Record<string, unknown>[]>} */ (exported.tables);
  assert.equal(exported.exportFormatVersion, 11);
  assert.deepEqual(JSON.parse(String(tables.gemini_grounding_receipts[0].metadata_json)), parsed.receipt);
});
