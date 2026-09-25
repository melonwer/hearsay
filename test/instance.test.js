import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConfig } from '../core/config.js';
import { get, getSetting, openDb, run, setSetting, SETTING_KEYS } from '../core/db.js';
import { assertInstancePaths } from '../core/instance.js';
import { startServer } from '../server.js';

test('demo and real setup use separate databases and preserve both when switching', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-instance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realDb = join(dir, 'hearsay.db');
  const common = { HEARSAY_DB_PATH: realDb, OPENAI_API_KEY: 'test-key' };
  const demoConfig = buildConfig({ ...common, HEARSAY_DEMO: '1' });
  const demo = await startServer({ config: demoConfig, port: 0, portFile: join(dir, 'demo.port'), log: () => {} });
  const demoCount = Number(get(demo.db, 'SELECT COUNT(*) AS n FROM responses')?.n ?? 0);
  assert.ok(demoCount > 0);
  assert.equal(getSetting(demo.db, SETTING_KEYS.INSTANCE_KIND, null), 'demo');
  const demoRun = await fetch(`http://127.0.0.1:${demo.port}/api/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(demoRun.status, 400);
  await demo.close();

  const realConfig = buildConfig({ ...common, OPENAI_API_KEY: '' });
  const real = await startServer({ config: realConfig, port: 0, portFile: join(dir, 'real.port'), log: () => {} });
  assert.equal(Number(get(real.db, 'SELECT COUNT(*) AS n FROM entities')?.n ?? 0), 0);
  run(real.db, "INSERT INTO entities(name, is_self, created_at) VALUES('My Real Brand', 1, '2026-09-25T00:00:00Z')");
  await real.close();

  const demoAgain = await startServer({ config: demoConfig, port: 0, portFile: join(dir, 'demo.port'), log: () => {} });
  assert.equal(Number(get(demoAgain.db, 'SELECT COUNT(*) AS n FROM responses')?.n ?? 0), demoCount);
  assert.equal(get(demoAgain.db, "SELECT name FROM entities WHERE is_self = 1")?.name, 'Notewell');
  await demoAgain.close();

  const realAgain = await startServer({ config: realConfig, port: 0, portFile: join(dir, 'real.port'), log: () => {} });
  assert.equal(get(realAgain.db, "SELECT name FROM entities WHERE is_self = 1")?.name, 'My Real Brand');
  assert.equal(Number(get(realAgain.db, 'SELECT COUNT(*) AS n FROM responses')?.n ?? 0), 0);
  await realAgain.close();
  assert.ok(existsSync(realDb));
  assert.ok(existsSync(demoConfig.demoDbPath));
});

test('path collisions and a legacy demo database cannot be opened as real data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'hearsay.db');
  assert.throws(() => assertInstancePaths(buildConfig({ HEARSAY_DB_PATH: path,
    HEARSAY_DEMO_DB_PATH: path })), /overlap/);
  assert.throws(() => assertInstancePaths(buildConfig({ HEARSAY_DB_PATH: path,
    HEARSAY_DATA_DIR: join(dir, 'shared'), HEARSAY_DEMO_DATA_DIR: join(dir, 'shared') })), /overlap/);

  const legacy = openDb(path);
  setSetting(legacy, SETTING_KEYS.SEEDED_AT, '2026-09-24T00:00:00Z');
  legacy.close();
  const config = buildConfig({ HEARSAY_DB_PATH: path });
  await assert.rejects(startServer({ config, port: 0, portFile: join(dir, 'real.port') }), /contains demo data/);
  const preserved = openDb(path);
  assert.equal(getSetting(preserved, SETTING_KEYS.SEEDED_AT, null), '2026-09-24T00:00:00Z');
  assert.equal(getSetting(preserved, SETTING_KEYS.INSTANCE_KIND, null), null);
  preserved.close();
});
