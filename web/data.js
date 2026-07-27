/**
 * Bridge from the web lane to the statistical core (§7 metrics, §4.3 cost, §6.7
 * suggest, §8.1 runner).
 *
 * The lanes land independently, so this module imports each core module as a
 * namespace and calls the §7/§4.3 functions through a guard. The contract is the
 * signature in the plan; the guard only decides what happens *before* a lane has
 * merged: a page renders its empty state and an endpoint answers 503, rather than
 * the whole server failing to link or — far worse — a page inventing numbers
 * (§19.6 #10).
 *
 * Integration note for Phase 2: §7 writes the metrics signatures without a database
 * handle (`mentionRate({entityId, provider?, days})`). Because `core/metrics.js` has
 * to read *some* database, this bridge passes the open handle as an extra `db` key in
 * the same options object. A metrics implementation that opens its own handle simply
 * ignores it; one that wants an injected handle finds it there.
 */

import * as metrics from '../core/metrics.js';
import * as cost from '../core/cost.js';
import * as suggest from '../core/suggest.js';
import * as runner from '../core/runner.js';
import * as providers from '../core/providers/index.js';

export { metrics, cost, suggest, runner, providers };

/** Thrown when a core function this endpoint needs has not been merged yet. */
export class NotReadyError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`${name} is not available in this build`);
    this.name = 'NotReadyError';
    /** @type {string} */
    this.fnName = name;
  }
}

/**
 * @param {Record<string, unknown>} mod
 * @param {string} name
 * @returns {boolean}
 */
export function has(mod, name) {
  return typeof mod[name] === 'function';
}

/**
 * Call a core function, or return `fallback` when that lane has not landed. Used by
 * pages, which must degrade to an empty panel rather than a stack trace.
 *
 * `T` is deliberately *not* inferred from `fallback` (`NoInfer`): the useful shape is
 * the one the caller declares for the result, and a `null` fallback would otherwise
 * collapse the whole call to `null`.
 *
 * @template T
 * @param {Record<string, unknown>} mod
 * @param {string} name
 * @param {unknown} args
 * @param {NoInfer<T>} fallback
 * @returns {T}
 */
export function soft(mod, name, args, fallback) {
  const fn = mod[name];
  if (typeof fn !== 'function') return fallback;
  try {
    return /** @type {T} */ (fn(args));
  } catch (err) {
    process.stderr.write(`[hearsay] ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return fallback;
  }
}

/**
 * Call a core function, or throw `NotReadyError`. Used by the JSON API, which must
 * not answer 200 with a made-up shape.
 *
 * @param {Record<string, unknown>} mod
 * @param {string} name
 * @param {unknown} args
 * @returns {unknown}
 */
export function strict(mod, name, args) {
  const fn = mod[name];
  if (typeof fn !== 'function') throw new NotReadyError(name);
  return fn(args);
}
