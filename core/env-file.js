import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse KEY=VALUE lines without interpolation or multi-line values.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Combine a local .env file with real environment variables taking precedence.
 * @param {Record<string, string|undefined>} env
 * @param {string} [file]
 * @returns {Record<string, string|undefined>}
 */
export function withEnvFile(env, file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return { ...env };
  /** @type {Record<string, string|undefined>} */
  const merged = { ...parseEnvFile(readFileSync(file, 'utf8')) };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Format a single value for a KEY=VALUE line so `parseEnvFile` round-trips it identically.
 * Rejects control characters (`\r`, `\n`, `\0`) so line injection is impossible.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function formatEnvValue(key, value) {
  if (!ENV_KEY_RE.test(key)) {
    throw new RangeError(`Invalid environment variable name: ${key}`);
  }
  const str = String(value);
  if (/[\r\n\0]/.test(str)) {
    throw new RangeError(`Environment value for ${key} cannot contain newlines or null bytes`);
  }
  if (str === '') return '';
  const needsQuotes =
    /^\s|\s$|#/.test(str) ||
    (str.length >= 2 &&
      ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))));
  let formatted = str;
  if (needsQuotes) {
    if (!str.includes('"')) {
      formatted = `"${str}"`;
    } else if (!str.includes("'")) {
      formatted = `'${str}'`;
    } else {
      throw new RangeError(`Environment value for ${key} cannot mix single and double quotes with whitespace/#`);
    }
  }
  if (parseEnvFile(`${key}=${formatted}`)[key] !== str) {
    throw new RangeError(`Environment value for ${key} could not be safely encoded`);
  }
  return formatted;
}

/**
 * Atomically create or update a `.env` file with strict `0600` permissions.
 * Existing comments, blank lines, and unrelated keys are preserved in order.
 * Passing `null` or `""` for a key removes that key from the `.env` file.
 *
 * @param {string} file
 * @param {Record<string, string|null|undefined>} updates
 * @returns {Record<string, string>} parsed contents of the resulting `.env` file
 */
export function updateEnvFile(file, updates) {
  const target = resolve(file);
  /** @type {Map<string, string|null>} */
  const pending = new Map();
  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue === undefined) continue;
    if (!ENV_KEY_RE.test(key)) {
      throw new RangeError(`Invalid environment variable name: ${key}`);
    }
    if (rawValue === null || rawValue === '') {
      pending.set(key, null);
    } else {
      pending.set(key, formatEnvValue(key, rawValue));
    }
  }

  const existingText = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const rawLines = existingText === '' ? [] : existingText.split(/\r?\n/);
  // Drop a single trailing empty element from a trailing newline so we don't double-space.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const outLines = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        if (ENV_KEY_RE.test(key) && pending.has(key)) {
          const formatted = pending.get(key);
          if (formatted !== null && formatted !== undefined && !seen.has(key)) {
            outLines.push(`${key}=${formatted}`);
            seen.add(key);
          } else {
            seen.add(key);
          }
          continue;
        }
      }
    }
    outLines.push(line);
  }

  for (const [key, formatted] of pending.entries()) {
    if (seen.has(key) || formatted === null) continue;
    outLines.push(`${key}=${formatted}`);
  }

  const content = outLines.length > 0 ? `${outLines.join('\n')}\n` : '';
  mkdirSync(dirname(target), { recursive: true });

  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }

  return parseEnvFile(content);
}
