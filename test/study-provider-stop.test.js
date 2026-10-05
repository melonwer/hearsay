import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { studyFixture } from '../test-support/study-fixture.js';
import { previewResearchRun, writeJson } from '../core/research-workspace.js';
import { approveStudy, captureStudyPage, loadStudy, recordStudyVersion } from '../core/study-workspace.js';
import { collectStudyOccurrence, prepareStudyResearch, studyScheduleTick } from '../core/study-schedule.js';

const first = new Date('2026-10-02T08:00:00Z');
const due = new Date('2026-10-03T09:00:00Z');
const later = new Date('2026-10-04T09:00:00Z');

async function mixedStudy(t, includeClaude = false, useAgy = false) {
  const f = await studyFixture(t, { tavily: { enabled: true, accountId: 'fixture-account', searchDepth: 'basic', maxResults: 5,
    collectionCredits: 180, diagnosticCredits: 20, allowance: 200, strictFreeMode: true } });
  f.project.selectedRoutes = includeClaude ? ['codex-agent', 'claude-code-agent'] : ['codex-agent'];
  Object.assign(f.project.executions[0], { routes: [{ id: 'codex-agent', provider: 'openai', profile: 'codex-search-v1', executable: '/fixture/codex' }], timeoutMs: 1000, idleTimeoutMs: 1000, maxOutputBytes: 100000 });
  if (includeClaude) f.project.executions[0].routes.push({ id: 'claude-code-agent', provider: 'anthropic', profile: 'claude-code-search-v1', executable: '/fixture/claude' });
  if (useAgy) {
    f.project.selectedRoutes = ['agy-cli'];
    f.project.executions[0].routes = [{ id: 'agy-cli', provider: 'gemini', profile: 'agy-search-v2', executable: '/fixture/agy' }];
  }
  writeJson(join(f.projectDirectory, 'project.json'), f.project);
  const preview = await previewResearchRun(f.projectDirectory, { discover: async (routes) => routes.map((route) => ({ id: route.id, executable: route.executable, profile: route.profile, version: 'fixture', profileHash: 'fixture-profile' })) });
  const bound = await prepareStudyResearch(f.directory, { preview, now: first });
  await approveStudy(f.directory, bound.quoteId, { author: 'owner', now: first });
  const page = await captureStudyPage(f.directory, { html: '<h1>Outfit feedback</h1>', now: first });
  await recordStudyVersion(f.directory, { id: 'v1', pageId: page.id, status: 'published', author: 'owner', publishedAt: first.toISOString() });
  const state = { searches: 0, measurements: 0, login: true, quota: false, providerError: false, measurementError: false, identityError: false, runtimeIdentityError: false };
  const options = { researchPreview: preview, apiKey: 'fixture-key', accountDirectory: join(f.projectDirectory, 'account'),
    fetch: async (url) => {
      if (String(url).endsWith('/usage')) return Response.json({ key: { usage: state.quota ? 1000 : state.searches, limit: 1000 },
        account: { current_plan: 'free', plan_usage: state.quota ? 1000 : state.searches, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } });
      state.searches++;
      if (state.providerError) return Response.json({ error: 'unauthorized fixture' }, { status: 401 });
      return Response.json({ request_id: `request-${state.searches}`, usage: { credits: 1 }, results: [{ url: 'https://drip.example/', title: 'Drip Score', content: 'Outfit feedback', score: 0.9 }] });
    },
    runnerFactory: (route) => ({
      preflight: async () => { if (!state.login) throw Object.assign(new Error('Login required'), { code: 'authentication_missing' }); return { ...(useAgy ? { configuredLogin: 'native_keyring_available', authenticated: false } : { authenticated: true, authKind: 'subscription' }), cliVersion: state.identityError ? 'changed version' : 'fixture' }; },
      run: async () => {
        state.measurements++;
        if (state.measurementError) return { text: null, errorCode: 'quota_exhausted' };
        if (state.runtimeIdentityError && route === 'codex-agent') return { text: 'Changed runtime', cliVersion: 'changed version' };
        return { text: 'Drip Score provides outfit feedback.', searchEvents: [{ eventType: 'search', status: 'completed', query: 'outfit apps', results: [] }],
          sessionIsolation: true, brandContext: false, cliVersion: 'fixture', executionProfileHash: 'fixture-profile' };
      },
    }),
  };
  const baseline = await collectStudyOccurrence(f.directory, { ...options, now: first });
  assert.equal(baseline.status, 'completed', JSON.stringify(baseline));
  assert.equal(state.searches, 6); assert.equal(state.measurements, includeClaude ? 12 : 6);
  return { ...f, state, options };
}

for (const failure of ['lost_login', 'missing_key', 'quota']) {
  test(`scheduled ${failure} stops all selected providers before spending`, async (t) => {
    const f = await mixedStudy(t);
    if (failure === 'lost_login') f.state.login = false;
    if (failure === 'quota') f.state.quota = true;
    const options = { ...f.options, ...(failure === 'missing_key' ? { apiKey: '' } : {}) };
    assert.equal((await studyScheduleTick(f.directory, { ...options, now: due })).status, 'stopped');
    assert.equal(f.state.searches, 6); assert.equal(f.state.measurements, 6);
    assert.equal(loadStudy(f.directory).manifest.status, 'stopped');
    assert.equal((await studyScheduleTick(f.directory, { ...f.options, now: later })).status, 'stopped');
    assert.equal(f.state.searches, 6); assert.equal(f.state.measurements, 6);
  });
}

test('a provider authentication failure during collection stops sibling measurements and later ticks', async (t) => {
  const f = await mixedStudy(t); f.state.providerError = true;
  await studyScheduleTick(f.directory, { ...f.options, now: due });
  assert.equal(f.state.searches, 7); assert.equal(f.state.measurements, 6);
  assert.equal(loadStudy(f.directory).manifest.status, 'stopped');
  assert.equal((await studyScheduleTick(f.directory, { ...f.options, now: later })).status, 'stopped');
  assert.equal(f.state.searches, 7);
});

test('changed account preflight identity stops before Tavily or measurement work', async (t) => {
  const f = await mixedStudy(t); f.state.identityError = true;
  assert.equal((await studyScheduleTick(f.directory, { ...f.options, now: due })).status, 'stopped');
  assert.equal(f.state.searches, 6); assert.equal(f.state.measurements, 6);
});

test('identity drift discovered by a measurement stops later questions and account routes', async (t) => {
  const f = await mixedStudy(t, true); f.state.runtimeIdentityError = true;
  await studyScheduleTick(f.directory, { ...f.options, now: due });
  assert.equal(f.state.measurements, 13);
  assert.equal(loadStudy(f.directory).manifest.status, 'stopped');
});

test('an account quota result permanently stops repeats after preserving the occurrence', async (t) => {
  const f = await mixedStudy(t); f.state.measurementError = true;
  await studyScheduleTick(f.directory, { ...f.options, now: due });
  assert.equal(loadStudy(f.directory).manifest.status, 'stopped');
  const searches = f.state.searches;
  assert.equal((await studyScheduleTick(f.directory, { ...f.options, now: later })).status, 'stopped');
  assert.equal(f.state.searches, searches);
  assert.ok(loadStudy(f.directory).manifest.analysisDue.length > 0);
});


test('a quota result stops subsequent account providers in the same scheduled occurrence', async (t) => {
  const f = await mixedStudy(t, true); f.state.measurementError = true;
  await studyScheduleTick(f.directory, { ...f.options, now: due });
  assert.equal(f.state.measurements, 13);
  assert.equal(loadStudy(f.directory).manifest.status, 'stopped');
});

test('a search-verified Antigravity baseline can repeat with available native keyring without claiming verified authentication', async (t) => {
  const f = await mixedStudy(t, false, true);
  const result = await studyScheduleTick(f.directory, { ...f.options, now: due });
  assert.equal(result.status, 'completed');
  assert.equal(f.state.searches, 12); assert.equal(f.state.measurements, 12);
  f.state.login = false;
  assert.equal((await studyScheduleTick(f.directory, { ...f.options, now: later })).status, 'stopped');
  assert.equal(f.state.searches, 12);
});
