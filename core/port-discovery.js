/**
 * Local HTTP-port discovery shared by the Hearsay server and its stdio MCP proxy.
 * The discovery record contains only a positive TCP port, never credentials or
 * request data.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

/** Default discovery file used by both the HTTP server and MCP process. */
export const DEFAULT_PORT_FILE = resolve(CORE_DIR, '../data/hearsay.port');

/** @param {number} port @returns {boolean} */
function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Resolve the configured discovery path. Relative overrides are relative to the
 * current process directory, matching the repository's other path settings.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolvePortFilePath(env = process.env) {
  const configured = String(env.HEARSAY_PORT_FILE ?? '').trim();
  return configured === '' ? DEFAULT_PORT_FILE : resolve(configured);
}

/**
 * Read and validate one discovery record.
 *
 * @param {string} file
 * @returns {number|null}
 */
export function readPortFile(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (!/^[1-9][0-9]{0,4}\n?$/.test(text)) return null;
    const port = Number.parseInt(text, 10);
    return validPort(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Atomically publish a discovery record with local-only file permissions.
 *
 * @param {string} file
 * @param {number} port
 * @returns {string}
 */
export function writePortFile(file, port) {
  if (!validPort(port)) throw new RangeError(`Invalid TCP port: ${port}`);

  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${port}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    return target;
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The original error is more useful than a best-effort cleanup failure.
    }
    throw error;
  }
}

/**
 * Remove a discovery record only when it still belongs to this port owner.
 *
 * @param {string} file
 * @param {number} port
 * @returns {boolean}
 */
export function removePortFile(file, port) {
  if (readPortFile(file) !== port) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the backend URL for one MCP request.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{url: string|null, file: string, message: string|null}}
 */
export function resolveHearsayUrl(env = process.env) {
  const file = resolvePortFilePath(env);
  const explicit = String(env.HEARSAY_URL ?? '').trim();
  if (explicit !== '') {
    return { url: explicit.replace(/\/+$/, ''), file, message: null };
  }

  const port = readPortFile(file);
  if (port !== null) return { url: `http://127.0.0.1:${port}`, file, message: null };

  return {
    url: null,
    file,
    message: `Hearsay is not started: run \`node server.js\`; no valid port discovery file was found at ${file}.`,
  };
}
