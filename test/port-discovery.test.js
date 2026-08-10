import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_PORT_FILE,
  readPortFile,
  removePortFile,
  resolveHearsayUrl,
  resolvePortFilePath,
  writePortFile,
} from '../core/port-discovery.js';

function tempDirectory() {
  return mkdtempSync(join(tmpdir(), 'hearsay-port-'));
}

test('automatic discovery uses a strict positive port and explicit URL wins', () => {
  const directory = tempDirectory();
  const file = join(directory, 'hearsay.port');

  writePortFile(file, 43127);
  assert.equal(resolveHearsayUrl({ HEARSAY_PORT_FILE: file }).url, 'http://127.0.0.1:43127');
  assert.equal(resolveHearsayUrl({ HEARSAY_URL: 'http://example.test:9000/' }).url, 'http://example.test:9000');
  assert.equal(resolvePortFilePath({ HEARSAY_PORT_FILE: 'relative.port' }), resolve(process.cwd(), 'relative.port'));
  assert.match(DEFAULT_PORT_FILE, /data[\\/]hearsay\.port$/);
});

test('missing or malformed discovery does not fall back to port 3000', () => {
  const directory = tempDirectory();
  const missingFile = join(directory, 'missing.port');
  const malformedFile = join(directory, 'malformed.port');

  const missing = resolveHearsayUrl({ HEARSAY_PORT_FILE: missingFile });
  assert.equal(missing.url, null);
  assert.match(missing.message, /start.*server/i);
  assert.doesNotMatch(missing.message, /:3000/);

  writeFileSync(malformedFile, '3000x\n', 'utf8');
  assert.equal(readPortFile(malformedFile), null);
  assert.equal(resolveHearsayUrl({ HEARSAY_PORT_FILE: malformedFile }).url, null);
});

test('port file writes atomically and conditional cleanup preserves another owner', () => {
  const file = join(tempDirectory(), 'nested', 'hearsay.port');

  writePortFile(file, 43127);
  assert.equal(readPortFile(file), 43127);
  assert.equal(readFileSync(file, 'utf8'), '43127\n');

  writePortFile(file, 43128);
  removePortFile(file, 43127);
  assert.equal(readPortFile(file), 43128);
  removePortFile(file, 43128);
  assert.equal(readPortFile(file), null);
  assert.equal(existsSync(file), false);
});
