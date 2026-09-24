/**
 * Provider registry — the adapters behind the providers enabled by env (§5).
 *
 * `core/config.js` decides which providers are enabled (a provider is enabled iff its
 * key env var is non-empty) and which model each one uses. This module maps those ids
 * onto adapter implementations, all of which share one contract:
 *
 *   `runPrompt(text, {model, timeoutMs, apiKey}) → Promise<ProviderResult>`
 */

import { PROVIDER_IDS, config } from '../config.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import * as perplexity from './perplexity.js';

/** @typedef {import('../config.js').ProviderId} ProviderId */
/** @typedef {import('./shared.js').ProviderResult} ProviderResult */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {(text: string, opts?: {model?: string, timeoutMs?: number, apiKey?: string,
 *   searchPolicy?: 'off'|'auto'|'required'|'legacy', maxOutputTokens?: number|null,
 *   maxResponseBytes?: number|null}) => Promise<ProviderResult>} runPrompt
 */

/** @type {Record<ProviderId, ProviderAdapter>} */
export const adapters = {
  openai,
  anthropic,
  gemini,
  perplexity,
};

/**
 * @param {string} id
 * @returns {ProviderAdapter|null}
 */
export function getAdapter(id) {
  return Object.hasOwn(adapters, id) ? adapters[/** @type {ProviderId} */ (id)] : null;
}

/**
 * Adapters for the providers that currently have a key, in stable UI order (§11.1).
 *
 * @param {import('../config.js').Config} [cfg]
 * @returns {{id: ProviderId, label: string, model: string, adapter: ProviderAdapter}[]}
 */
export function enabledAdapters(cfg = config) {
  return PROVIDER_IDS.filter((id) => cfg.providers[id].enabled).map((id) => ({
    id,
    label: cfg.providers[id].label,
    model: cfg.providers[id].model,
    adapter: adapters[id],
  }));
}
