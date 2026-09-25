/**
 * End-to-end suite (§15 e2e row + SPEC §8): every page renders on an empty DB, and a
 * seeded demo instance tells the §12 story through the public API — no live network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, api } from './api.test.js';

const PAGES = ['/', '/answers', '/prompts', '/entities', '/alerts', '/settings', '/methodology', '/setup'];

test('e2e: every page renders on an empty DB', async () => {
  const app = await boot();
  try {
    for (const path of PAGES) {
      const res = await fetch(app.base + path);
      // '/' 302s to /setup on a cold DB (§11.8); fetch follows it to a 200.
      assert.ok([200, 302].includes(res.status), `${path} → ${res.status}`);
    }
  } finally {
    await app.close();
  }
});

test('e2e: seeded demo instance tells the full story', async () => {
  const app = await boot({ HEARSAY_DEMO: '1' }); // auto-seeds when empty (§12)
  try {
    const summary = await api(app.base, 'GET', '/api/summary');
    assert.equal(summary.status, 200);
    for (const key of ['brand', 'windowDays', 'generatedAt', 'demo', 'sov', 'mentionRate', 'recommendationRate', 'providers', 'openAlerts', 'lastRun']) {
      assert.ok(key in summary.body, `summary missing ${key}`); // §10.4 key-shape
    }
    assert.equal(summary.body.demo, true);
    assert.equal(summary.body.openAlerts, 0, 'complete demo series should not invent business-change alerts');
    const series = await api(app.base, 'GET', '/api/series?days=30');
    assert.equal(series.body.series.length, 4);
    assert.ok(series.body.series.every((item) => item.comparableAnswers > 0));

    assert.equal((await api(app.base, 'POST', '/api/run', { confirm: true })).status, 400); // demo blocks runs
    assert.equal((await api(app.base, 'POST', '/api/setup', { brand: { name: 'X' } })).status, 400);

    const answers = await api(app.base, 'GET', '/api/answers?provider=perplexity');
    assert.ok(answers.body.items.length > 0, 'seeded perplexity answers exist');
    assert.ok(answers.body.items.every((/** @type {*} */ item) => item.provider === 'perplexity'));

    const s = await api(app.base, 'GET', '/api/status');
    assert.equal(s.body.demo, true);
    assert.equal(s.body.configured, true);
  } finally {
    await app.close();
  }
});
