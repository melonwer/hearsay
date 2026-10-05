import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
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
