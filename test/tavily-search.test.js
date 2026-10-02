import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const { collectTavily, inspectTavilyLedger, previewTavilyReconciliation, reconcileTavilyLedger } = await import('../core/tavily-search.js');
const KEY = 'tvly-test-secret-never-save';
const SIX = Array.from({ length: 6 }, (_, i) => ({ id: `q${i + 1}`, angleId: `a${Math.floor(i / 2) + 1}`, text: `Which outfit app helps with task ${i + 1}?` }));

function fixture(t, overrides = {}) {
  const accountDirectory = mkdtempSync(join(tmpdir(), 'hearsay-tavily-'));
  t.after(() => rmSync(accountDirectory, { recursive: true, force: true }));
  const requests = [];
  let used = 0;
  const usage = () => ({ key: { usage: used, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: used, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } });
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/usage')) return Response.json(overrides.usage ? overrides.usage() : usage(), { status: overrides.usageStatus ?? 200 });
    if (overrides.search) return overrides.search(url, init);
    used += JSON.parse(init.body).search_depth === 'advanced' ? 2 : 1;
    return Response.json({ query: JSON.parse(init.body).query, request_id: `request-${used}`, usage: { credits: JSON.parse(init.body).search_depth === 'advanced' ? 2 : 1 }, results: [{ url: 'https://outfit.example', title: 'Outfit app', content: 'Feedback for an outfit photo', score: 0.75 }] });
  };
  const options = { accountDirectory, accountId: 'shared-account', studyKey: 'app-a:study-a:plan-a', allowance: 200, collectionCredits: 180, diagnosticCredits: 20, occurrenceId: 'day-1', lane: 'collection', queries: SIX, searchDepth: 'basic', maxResults: 5, strictFreeMode: true, apiKey: KEY, fetch, now: '2026-10-02T08:00:00Z' };
  return { accountDirectory, options, requests, searches: () => requests.filter((r) => r.url.endsWith('/search')) };
}

test('basic searches preserve source evidence and exact frozen request settings', async (t) => {
  assert.equal(typeof collectTavily, 'function');
  const f = fixture(t);
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.records.length, 6);
  assert.equal(receipt.records[0].requestId, 'request-1');
  assert.deepEqual(receipt.records[0].results, [{ url: 'https://outfit.example', title: 'Outfit app', content: 'Feedback for an outfit photo', score: 0.75 }]);
  assert.deepEqual(JSON.parse(f.searches()[0].init.body), { query: SIX[0].text, search_depth: 'basic', auto_parameters: false, include_answer: false, include_usage: true, max_results: 5 });
  assert.equal(receipt.creditSummary.spent, 6);
  assert.equal(receipt.creditSummary.remainingCollection, 174);
  assert.equal(receipt.creditSummary.remainingDiagnostic, 20);
  assert.equal(receipt.records[0].raw.usage.credits, 1);
  assert.equal(receipt.startedAt, '2026-10-02T08:00:00.000Z');
});

test('baseline and 29 repeats exhaust exactly 180 collection credits', async (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 30; i++) assert.equal((await collectTavily({ ...f.options, occurrenceId: `day-${i}` })).status, 'completed');
  const extra = await collectTavily({ ...f.options, occurrenceId: 'day-31' });
  assert.equal(extra.status, 'paused');
  assert.equal(extra.creditSummary.stopReason, 'collection_allowance');
  assert.equal(f.searches().length, 180);
  const diagnostic = await collectTavily({ ...f.options, lane: 'diagnostic', occurrenceId: 'freshness-1', queries: [{ ...SIX[0], text: 'Outfit app brand freshness check' }] });
  assert.equal(diagnostic.creditSummary.remainingDiagnostic, 19);
  assert.equal(diagnostic.creditSummary.remainingCollection, 0);
  assert.equal(inspectTavilyLedger(f.accountDirectory, 'shared-account').studies[f.options.studyKey].spent.collection, 180);
});

test('completed occurrence receipts are immutable and no requests repeat', async (t) => {
  const f = fixture(t);
  const receipt = await collectTavily(f.options);
  const calls = f.requests.length;
  assert.deepEqual(await collectTavily(f.options), receipt);
  assert.equal(f.requests.length, calls);
  await assert.rejects(collectTavily({ ...f.options, queries: [{ ...SIX[0], text: 'Changed wording' }, ...SIX.slice(1)] }), { code: 'scope_changed' });
  assert.equal(f.requests.length, calls);
});

test('advanced searches charge two credits within an explicit depth scope', async (t) => {
  const f = fixture(t);
  const receipt = await collectTavily({ ...f.options, searchDepth: 'advanced', queries: SIX.slice(0, 1) });
  assert.equal(receipt.creditSummary.spent, 2);
  await assert.rejects(collectTavily({ ...f.options, searchDepth: 'basic', queries: SIX.slice(0, 1), occurrenceId: 'day-2' }), { code: 'scope_changed' });
  assert.equal(f.searches().length, 1);
});

test('unknown documented usage pauses without searching', async (t) => {
  for (const usage of [{}, { key: { usage: 0, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: null, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }]) {
    const f = fixture(t, { usage: () => usage });
    const receipt = await collectTavily(f.options);
    assert.equal(receipt.status, 'paused');
    assert.equal(receipt.creditSummary.stopReason, 'unknown_capacity');
    assert.equal(f.searches().length, 0);
  }
});

test('strict free mode rejects unlimited paid fallback and paid accounts', async (t) => {
  for (const account of [
    { current_plan: 'Researcher', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: null },
    { current_plan: 'Bootstrap', plan_usage: 0, plan_limit: 15000, paygo_usage: 0, paygo_limit: 0 },
  ]) {
    const f = fixture(t, { usage: () => ({ key: { usage: 0, limit: null }, account }) });
    const receipt = await collectTavily(f.options);
    assert.equal(receipt.creditSummary.stopReason, 'free_mode_unprotected');
    assert.equal(f.searches().length, 0);
  }
});

test('key caps cannot promise strict free mode while account paid fallback remains enabled', async (t) => {
  const f = fixture(t, { usage: () => ({ key: { usage: 200, limit: 300 }, account: { current_plan: 'Researcher', plan_usage: 900, plan_limit: 1000, paygo_usage: 0, paygo_limit: 1000 } }) });
  assert.equal((await collectTavily(f.options)).creditSummary.stopReason, 'free_mode_unprotected');
  assert.equal(f.searches().length, 0);
});

test('external account and key usage reduce capacity before sends', async (t) => {
  const f = fixture(t, { usage: () => ({ key: { usage: 998, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: 998, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }) });
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.creditSummary.stopReason, 'account_capacity');
  assert.equal(f.searches().length, 2);
  assert.equal(receipt.creditSummary.spent, 2);
});

test('two apps serialize reservations against shared stale usage', async (t) => {
  const f = fixture(t, { usage: () => ({ key: { usage: 999, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: 999, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }) });
  const receipts = await Promise.all([collectTavily({ ...f.options, queries: SIX.slice(0, 1) }), collectTavily({ ...f.options, studyKey: 'app-b:study-b:plan-a', queries: SIX.slice(0, 1) })]);
  assert.equal(f.searches().length, 1);
  assert.equal(receipts.filter((r) => r.status === 'completed').length, 1);
});

test('ambiguous failures remain charged and duplicate occurrences never retry', async (t) => {
  const f = fixture(t, { search: async () => { throw new Error(`Timeout echoes ${KEY}`); } });
  const receipt = await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.records[0].status, 'ambiguous');
  assert.equal(receipt.records[0].credits, 1);
  assert.equal(receipt.creditSummary.spent, 1);
  assert.deepEqual(await collectTavily({ ...f.options, queries: SIX.slice(0, 1) }), receipt);
  assert.equal(f.searches().length, 1);
  assert.equal(JSON.stringify(inspectTavilyLedger(f.accountDirectory, 'shared-account')).includes(KEY), false);
});

test('authentication and quota failures halt further account sends', async (t) => {
  for (const status of [401, 403, 429, 432, 433]) {
    const f = fixture(t, { search: async () => Response.json({ detail: { error: KEY } }, { status }) });
    const receipt = await collectTavily(f.options);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.creditSummary.spent, 1);
    assert.equal(f.searches().length, 1);
    await collectTavily({ ...f.options, occurrenceId: 'day-2' });
    assert.equal(f.searches().length, 1);
    assert.equal(JSON.stringify(receipt).includes(KEY), false);
  }
});

test('successful raw responses redact keys in arbitrary fields, values and result URLs', async (t) => {
  const f = fixture(t, { search: async () => Response.json({ request_id: 'req-clean', usage: { credits: 1 }, authorization: `Bearer ${KEY}`, nested: { strange: KEY }, results: [{ url: `https://outfit.example/?token=${KEY}`, title: KEY, content: `text ${KEY}`, score: 0.8 }] }) });
  const receipt = await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  assert.equal(receipt.status, 'completed');
  assert.equal(JSON.stringify(receipt).includes(KEY), false);
  assert.equal(JSON.stringify(inspectTavilyLedger(f.accountDirectory, 'shared-account')).includes(KEY), false);
});

test('malformed successful search remains charged and halts its occurrence', async (t) => {
  const f = fixture(t, { search: async () => Response.json({ request_id: 'bad-results', usage: { credits: 1 }, results: [{ url: 'not-a-url', title: 'x', content: 'x', score: 1 }] }) });
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.records[0].errorCode, 'invalid_response');
  assert.equal(receipt.records[0].credits, 1);
  assert.equal(f.searches().length, 1);
});

test('provider pricing or account policy changes halt later search requests', async (t) => {
  let paygo = 0;
  const f = fixture(t, { usage: () => ({ key: { usage: 0, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: paygo } }) });
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  paygo = 100;
  const second = await collectTavily({ ...f.options, queries: SIX.slice(0, 1), occurrenceId: 'day-2' });
  assert.equal(second.creditSummary.stopReason, 'policy_changed');
  assert.equal(f.searches().length, 1);
});

test('interrupted signal preserves prior charged evidence and skips remaining requests', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { search: async () => { controller.abort(); throw new Error('Aborted after send'); } });
  const receipt = await collectTavily({ ...f.options, signal: controller.signal });
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.creditSummary.spent, 1);
  assert.equal(receipt.records.filter((r) => r.status === 'skipped').length, 5);
  assert.equal(f.searches().length, 1);
});

test('missing keys and already-aborted requests cannot send provider requests', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const receipt = await collectTavily({ ...f.options, signal: controller.signal });
  assert.equal(receipt.status, 'interrupted');
  assert.equal(f.requests.length, 0);
  assert.equal(receipt.creditSummary.spent, 0);
});

test('scope validation rejects impossible budgets and unknown search profile fields', async (t) => {
  const f = fixture(t);
  for (const changes of [{ allowance: 199 }, { maxResults: 21 }, { searchDepth: 'auto' }, { collectionCredits: -1 }, { accountId: undefined }, { occurrenceId: undefined }, { queries: [{ ...SIX[0], id: undefined }] }, { queries: [{ ...SIX[0], apiKey: KEY }] }]) {
    await assert.rejects(collectTavily({ ...f.options, ...changes }), { code: 'invalid_scope' });
  }
  assert.equal(f.requests.length, 0);
});

test('successful responses with missing usage retain conservative unconfirmed credits', async (t) => {
  const f = fixture(t, { search: async () => Response.json({ request_id: 'usage-missing', results: [] }) });
  const receipt = await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.creditSummary.ambiguous, 1);
});

test('provider cost changes preserve actual exposed credits and halt subsequent requests', async (t) => {
  const f = fixture(t, { search: async () => Response.json({ request_id: 'price-change', usage: { credits: 2 }, results: [] }) });
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.creditSummary.spent, 2);
  assert.equal(receipt.creditSummary.stopReason, 'pricing_changed');
  await collectTavily({ ...f.options, occurrenceId: 'day-2' });
  assert.equal(f.searches().length, 1);
});

test('server failures are charged without an automatic retry', async (t) => {
  const f = fixture(t, { search: async () => new Response(`Service failed: ${KEY}`, { status: 500 }) });
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.creditSummary.spent, 1);
  assert.equal(receipt.records[0].errorCode, 'http_error');
  assert.equal(f.searches().length, 1);
  assert.equal(JSON.stringify(receipt).includes(KEY), false);
});

test('missing credentials pause collection without provider calls', async (t) => {
  const f = fixture(t);
  const receipt = await collectTavily({ ...f.options, apiKey: '' });
  assert.equal(receipt.creditSummary.stopReason, 'missing_key');
  assert.equal(f.requests.length, 0);
});

function child(options, action) {
  const { fetch, ...data } = options;
  const source = `
    import { collectTavily } from ${JSON.stringify(new URL('../core/tavily-search.js', import.meta.url).href)};
    const options = ${JSON.stringify(data)};
    options.fetch = async (url) => {
      if (url.endsWith('/usage')) return Response.json({ key: { usage: 999, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: 999, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } });
      ${action}
    };
    const result = await collectTavily(options);
    process.stdout.write(JSON.stringify({status: result.status}) + '\\n');
  `;
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source]);
    let output = '';
    let errors = '';
    process.stdout.on('data', (chunk) => { output += chunk; });
    process.stderr.on('data', (chunk) => { errors += chunk; });
    process.on('error', reject);
    process.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
  });
}

test('a process crash after reservation cannot spend a second time on restart', async (t) => {
  const f = fixture(t);
  await child(f.options, "process.stdout.write('reserved\\n'); process.exit(0);");
  const recovered = await collectTavily(f.options);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.creditSummary.spent, 1);
  assert.equal(recovered.creditSummary.ambiguous, 1);
  assert.equal(f.requests.length, 0);
  const next = await collectTavily({ ...f.options, occurrenceId: 'day-2' });
  assert.equal(next.creditSummary.stopReason, 'account_capacity');
  assert.equal(f.searches().length, 0);
});

test('independent processes cannot reserve the same final account credit', async (t) => {
  const f = fixture(t);
  const action = "process.stdout.write('search\\n'); await new Promise((resolve) => setTimeout(resolve, 100)); return Response.json({request_id:'one-credit',usage:{credits:1},results:[]});";
  const outputs = await Promise.all([child({ ...f.options, queries: SIX.slice(0, 1) }, action), child({ ...f.options, studyKey: 'app-b:study-b:plan-a', queries: SIX.slice(0, 1) }, action)]);
  assert.equal(outputs.join('').split('search\n').length - 1, 1);
  assert.equal(outputs.filter((s) => s.includes('"status":"completed"')).length, 1);
  const files = readdirSync(join(f.accountDirectory, 'tavily', 'shared-account'));
  for (const file of files) assert.equal(readFileSync(join(f.accountDirectory, 'tavily', 'shared-account', file)).includes(Buffer.from(KEY)), false);
});

test('caller mutations after usage inspection cannot alter the frozen approved query', async (t) => {
  const f = fixture(t);
  const options = { ...f.options, queries: SIX.map((q) => ({ ...q })) };
  const fetch = options.fetch;
  options.fetch = async (url, init) => {
    if (url.endsWith('/usage')) options.queries[0].text = 'Unexpected unapproved brand search';
    return fetch(url, init);
  };
  const receipt = await collectTavily(options);
  assert.equal(JSON.parse(f.searches()[0].init.body).query, 'Which outfit app helps with task 1?');
  assert.equal(receipt.records[0].query, 'Which outfit app helps with task 1?');
});

test('usage requests with unknown HTTP failures cannot search', async (t) => {
  const f = fixture(t, { usageStatus: 500 });
  const receipt = await collectTavily(f.options);
  assert.equal(receipt.status, 'paused');
  assert.equal(receipt.creditSummary.spent, 0);
  assert.equal(f.searches().length, 0);
});

test('non-strict mode uses finite key capacity when account paid capacity is unlimited', async (t) => {
  const f = fixture(t, { usage: () => ({ key: { usage: 4, limit: 5 }, account: { current_plan: 'Bootstrap', plan_usage: 100, plan_limit: 15000, paygo_usage: 0, paygo_limit: null } }) });
  const receipt = await collectTavily({ ...f.options, strictFreeMode: false });
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.creditSummary.spent, 1);
  assert.equal(f.searches().length, 1);
});

test('same-process simultaneous duplicate ticks share a single immutable result', async (t) => {
  const f = fixture(t);
  const [first, second] = await Promise.all([collectTavily(f.options), collectTavily(f.options)]);
  assert.deepEqual(first, second);
  assert.equal(f.searches().length, 6);
});

function recovery(f, changes = {}) {
  return { accountDirectory: f.accountDirectory, accountId: 'shared-account', reason: 'Owner checked usage and restored account access', apiKey: KEY, fetch: f.options.fetch, now: '2026-10-02T10:00:00Z', ...changes };
}

test('an exact reviewed reconciliation clears authentication halt and preserves earlier spending', async (t) => {
  const f = fixture(t, { search: async () => Response.json({ detail: { error: 'Invalid credentials' } }, { status: 401 }) });
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const preview = await previewTavilyReconciliation(recovery(f));
  assert.equal(preview.snapshot.accountId, 'shared-account');
  assert.equal(preview.usage.accountUsage, 0);
  const receipt = await reconcileTavilyLedger({ ...recovery(f), confirm: preview.quoteId, author: 'owner' });
  assert.equal(receipt.quoteId, preview.quoteId);
  assert.equal(receipt.author, 'owner');
  const ledger = inspectTavilyLedger(f.accountDirectory, 'shared-account');
  assert.equal(ledger.halted, null);
  assert.equal(ledger.studies[f.options.studyKey].spent.collection, 1);
  assert.equal(Object.values(ledger.reconciliations).length, 1);
  assert.equal(f.searches().length, 1);
  assert.equal(JSON.stringify(receipt).includes(KEY), false);
});

test('wrong or stale reconciliation quote makes no ledger changes', async (t) => {
  const f = fixture(t);
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const preview = await previewTavilyReconciliation(recovery(f));
  const before = inspectTavilyLedger(f.accountDirectory, 'shared-account');
  await assert.rejects(reconcileTavilyLedger({ ...recovery(f), confirm: 'wrong-quote', author: 'owner' }), { code: 'reconciliation_quote_changed' });
  assert.deepEqual(inspectTavilyLedger(f.accountDirectory, 'shared-account'), before);
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1), occurrenceId: 'day-2' });
  const changed = inspectTavilyLedger(f.accountDirectory, 'shared-account');
  await assert.rejects(reconcileTavilyLedger({ ...recovery(f), confirm: preview.quoteId, author: 'owner' }), { code: 'reconciliation_quote_changed' });
  assert.deepEqual(inspectTavilyLedger(f.accountDirectory, 'shared-account'), changed);
});

test('changed fresh provider usage invalidates an earlier reconciliation preview', async (t) => {
  let reported = 0;
  const f = fixture(t, { usage: () => ({ key: { usage: reported, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: reported, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }) });
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const preview = await previewTavilyReconciliation(recovery(f));
  reported = 20;
  const before = inspectTavilyLedger(f.accountDirectory, 'shared-account');
  await assert.rejects(reconcileTavilyLedger({ ...recovery(f), confirm: preview.quoteId, author: 'owner' }), { code: 'reconciliation_quote_changed' });
  assert.deepEqual(inspectTavilyLedger(f.accountDirectory, 'shared-account'), before);
});

test('policy recovery requires a fresh reviewed preview and rejects paid fallback in strict free mode', async (t) => {
  let limit = 1000;
  let paygo = 0;
  const f = fixture(t, { usage: () => ({ key: { usage: 0, limit }, account: { current_plan: 'Researcher', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: paygo } }) });
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  limit = 900;
  const stopped = await collectTavily({ ...f.options, queries: SIX.slice(0, 1), occurrenceId: 'day-2' });
  assert.equal(stopped.creditSummary.stopReason, 'policy_changed');
  const preview = await previewTavilyReconciliation(recovery(f));
  await reconcileTavilyLedger({ ...recovery(f), confirm: preview.quoteId, author: 'owner' });
  assert.equal(inspectTavilyLedger(f.accountDirectory, 'shared-account').halted, null);
  assert.equal((await collectTavily({ ...f.options, queries: SIX.slice(0, 1), occurrenceId: 'day-3' })).status, 'completed');
  paygo = 100;
  await assert.rejects(previewTavilyReconciliation(recovery(f)), { code: 'free_mode_unprotected' });
});

test('new billing period resets only account floors while retaining study limits and ambiguous charges', async (t) => {
  let reported = 999;
  const f = fixture(t, { usage: () => ({ key: { usage: reported, limit: 1000 }, account: { current_plan: 'Researcher', plan_usage: reported, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }), search: async () => { throw new Error('Timeout after sending'); } });
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  reported = 0;
  const ordinary = await previewTavilyReconciliation(recovery(f));
  await reconcileTavilyLedger({ ...recovery(f), confirm: ordinary.quoteId, author: 'owner' });
  assert.equal(inspectTavilyLedger(f.accountDirectory, 'shared-account').accountFloor, 999);
  const options = recovery(f, { newBillingPeriod: '2026-11', reason: 'Owner confirms the new November billing period' });
  const preview = await previewTavilyReconciliation(options);
  const receipt = await reconcileTavilyLedger({ ...options, confirm: preview.quoteId, author: 'owner' });
  assert.equal(receipt.newBillingPeriod, '2026-11');
  const ledger = inspectTavilyLedger(f.accountDirectory, 'shared-account');
  assert.equal(ledger.accountFloor, 0);
  assert.equal(ledger.studies[f.options.studyKey].spent.collection, 1);
  assert.equal(Object.values(ledger.reservations)[0].state, 'ambiguous');
  assert.equal(Object.values(ledger.occurrences)[0].receipt.creditSummary.spent, 1);
  const next = await collectTavily({ ...f.options, queries: SIX.slice(0, 1), occurrenceId: 'day-2' });
  assert.equal(next.creditSummary.remainingCollection, 178);
  assert.equal(next.creditSummary.accountRemaining, 998);
});

test('reconciliation refuses active in-flight reservations under the account lock', async (t) => {
  let release;
  let sent;
  const started = new Promise((resolve) => { sent = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { search: async () => { sent(); await gate; return Response.json({ request_id: 'released', usage: { credits: 1 }, results: [] }); } });
  const options = recovery(f);
  const preview = await previewTavilyReconciliation(options);
  const pending = collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  await started;
  try { await assert.rejects(reconcileTavilyLedger({ ...options, confirm: preview.quoteId, author: 'owner' }), { code: 'reconciliation_active' }); }
  finally { release(); await pending; }
});

test('reconciliation receipt retries are idempotent and cannot reset a billing label twice', async (t) => {
  const f = fixture(t);
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const options = recovery(f, { newBillingPeriod: '2026-11' });
  const preview = await previewTavilyReconciliation(options);
  const args = { ...options, confirm: preview.quoteId, author: 'owner' };
  const receipt = await reconcileTavilyLedger(args);
  assert.deepEqual(await reconcileTavilyLedger(args), receipt);
  await assert.rejects(previewTavilyReconciliation(options), { code: 'billing_period_reused' });
});

test('simultaneous confirmation of one recovery quote records one immutable receipt', async (t) => {
  const f = fixture(t);
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const options = recovery(f);
  const preview = await previewTavilyReconciliation(options);
  const args = { ...options, confirm: preview.quoteId, author: 'owner' };
  const [first, second] = await Promise.all([reconcileTavilyLedger(args), reconcileTavilyLedger(args)]);
  assert.deepEqual(first, second);
  assert.equal(Object.values(inspectTavilyLedger(f.accountDirectory, 'shared-account').reconciliations).length, 1);
});

test('recovery options retain their approved reason while provider inspection is asynchronous', async (t) => {
  const f = fixture(t);
  await collectTavily({ ...f.options, queries: SIX.slice(0, 1) });
  const options = recovery(f);
  const original = options.fetch;
  options.fetch = async (url, init) => { options.reason = 'Caller changed the reason during provider fetch'; return original(url, init); };
  const preview = await previewTavilyReconciliation(options);
  assert.equal(preview.snapshot.reason, 'Owner checked usage and restored account access');
});
