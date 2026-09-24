/**
 * Redacted provider-event artifacts and normalized search evidence.
 *
 * Provider streams are hostile, potentially secret-bearing input. This module makes
 * redaction the first operation and accepts only internally generated artifact refs for
 * reads/deletion. Search events are stored in SQLite separately from final-answer
 * citations so a search result is never silently presented as a cited source.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { get, run } from './db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_REF = /^[a-f0-9]{32}\.jsonl$/;
const SEARCH_EVENT_TYPES = ['search', 'fetch'];
const SEARCH_EVENT_STATUSES = ['started', 'completed', 'failed', 'denied', 'unavailable'];

export class ArtifactError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ArtifactError';
  }
}

/**
 * @typedef {Object} ArtifactStore
 * @property {string} root
 * @property {number} retentionDays
 * @property {number} maxBytes
 */

/**
 * @param {string} dataDir
 * @param {{retentionDays?:number, maxBytes?:number}} [options]
 * @returns {ArtifactStore}
 */
export function createArtifactStore(dataDir, options = {}) {
  const root = resolve(dataDir, 'artifacts');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows uses user-scoped ACLs; there are no portable POSIX mode bits to enforce.
  }
  const retentionDays = Number.isFinite(options.retentionDays) ? Math.max(1, Math.floor(Number(options.retentionDays))) : DEFAULT_RETENTION_DAYS;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Math.floor(Number(options.maxBytes))) : DEFAULT_MAX_BYTES;
  return {
    root,
    retentionDays,
    maxBytes,
  };
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function sensitiveKey(key) {
  return /token|authorization|api[_-]?key|secret|password|cookie|credential|email|account(?:[_-]?id)?|organization|workspace/i.test(key);
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk|m0)-[A-Za-z0-9_-]{8,}/g, '[REDACTED_TOKEN]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
}

/**
 * Redact secrets and identity fields recursively before an event is serialized.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactEvent(value, depth = 0) {
  if (depth > 12) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactEvent(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sensitiveKey(key) ? '[REDACTED]' : redactEvent(item, depth + 1);
  }
  return out;
}

/**
 * @param {ArtifactStore} store
 * @param {string} ref
 * @returns {string}
 */
function artifactPath(store, ref) {
  if (!ARTIFACT_REF.test(String(ref))) throw new ArtifactError('invalid artifact reference');
  const path = resolve(store.root, ref);
  const rel = relative(store.root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || path === store.root) throw new ArtifactError('invalid artifact reference');
  return path;
}

/**
 * Persist bounded JSONL after redaction. The response id is intentionally not part of
 * the filename: refs are opaque and cannot be used as a traversal or enumeration key.
 *
 * @param {ArtifactStore} store
 * @param {number} responseId
 * @param {unknown[]} events
 * @returns {string}
 */
export function writeArtifact(store, responseId, events) {
  if (!Array.isArray(events)) throw new ArtifactError('artifact events must be an array');
  const lines = [];
  let bytes = 0;
  for (const event of events) {
    const line = `${JSON.stringify(redactEvent(event))}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > store.maxBytes) throw new ArtifactError(`artifact output exceeds ${store.maxBytes} bytes`);
    lines.push(line);
  }
  // Keep the id in the call contract for future metadata linkage without allowing it to
  // influence a user-controlled path. SQLite owns the response/artifact relationship.
  void responseId;
  const ref = `${randomBytes(16).toString('hex')}.jsonl`;
  const finalPath = artifactPath(store, ref);
  const tempPath = join(store.root, `.${randomBytes(16).toString('hex')}.tmp`);
  writeFileSync(tempPath, lines.join(''), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Windows ACLs are user-scoped by directory ownership.
    }
    renameSync(tempPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original failure.
    }
    throw err;
  }
  return ref;
}

/**
 * @param {ArtifactStore} store
 * @param {string} ref
 * @returns {unknown[]}
 */
export function readArtifact(store, ref) {
  const path = artifactPath(store, ref);
  if (!existsSync(path)) throw new ArtifactError('artifact not found');
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/**
 * @param {ArtifactStore} store
 * @param {string|null|undefined} ref
 * @returns {'not_recorded'|'available'|'expired'}
 */
export function artifactAvailability(store, ref) {
  if (ref === null || ref === undefined || ref === '') return 'not_recorded';
  return existsSync(artifactPath(store, ref)) ? 'available' : 'expired';
}

/**
 * Delete expired event files without touching normalized SQLite responses.
 *
 * @param {ArtifactStore} store
 * @param {Date} [now]
 * @returns {number}
 */
export function cleanupArtifacts(store, now = new Date()) {
  const cutoff = now.getTime() - store.retentionDays * DAY_MS;
  let removed = 0;
  for (const ref of readdirSync(store.root)) {
    if (!ARTIFACT_REF.test(ref)) continue;
    const path = artifactPath(store, ref);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // A concurrently deleted artifact is already in the desired state.
    }
  }
  return removed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} allowed
 * @returns {string|null}
 */
function checked(value, field, allowed) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!allowed.includes(text)) throw new ArtifactError(`${field} must be one of: ${allowed.join(', ')}`);
  return text;
}

/**
 * Insert normalized search/fetch evidence; metadata is redacted before JSON encoding.
 *
 * @param {Db} db
 * @param {number} responseId
 * @param {Record<string, unknown>[]} evidence
 * @returns {number}
 */
export function recordSearchEvents(db, responseId, evidence) {
  if (!Array.isArray(evidence)) throw new ArtifactError('search evidence must be an array');
  let count = 0;
  for (const event of evidence) {
    const eventType = checked(event.eventType ?? event.event_type, 'eventType', SEARCH_EVENT_TYPES);
    const status = checked(event.status, 'status', SEARCH_EVENT_STATUSES);
    if (!eventType || !status) throw new ArtifactError('search event type and status are required');
    run(
      db,
      `INSERT INTO search_events(
         response_id, event_type, status, query, url, title, domain, observed_at, rank, provider_event_type, metadata
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(responseId),
        eventType,
        status,
        event.query === undefined || event.query === null ? null : redactString(String(event.query)),
        event.url === undefined || event.url === null ? null : String(event.url),
        event.title === undefined || event.title === null ? null : redactString(String(event.title)),
        event.domain === undefined || event.domain === null ? null : String(event.domain),
        String(event.observedAt ?? event.observed_at ?? new Date().toISOString()),
        event.rank === undefined || event.rank === null ? null : Number(event.rank),
        event.providerEventType === undefined || event.providerEventType === null ? null : String(event.providerEventType),
        event.metadata === undefined ? null : JSON.stringify(redactEvent(event.metadata)),
      ],
    );
    count += 1;
  }
  return count;
}

/**
 * A completed WebSearch/search event is the only verified-search proof.
 * @param {Db} db
 * @param {number} responseId
 * @returns {boolean}
 */
export function hasVerifiedSearch(db, responseId) {
  return get(db, `SELECT 1 AS hit FROM search_events WHERE response_id = ? AND event_type = 'search' AND status = 'completed' LIMIT 1`, [
    Number(responseId),
  ]) !== undefined;
}
