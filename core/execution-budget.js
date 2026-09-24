import { assertRoutePolicy } from './measurement-contract.js';
import { endpoint as openaiEndpoint } from './providers/openai.js';
import { endpoint as anthropicEndpoint, MAX_TOKENS as anthropicMaxTokens } from './providers/anthropic.js';
import { endpointFor as geminiEndpointFor } from './providers/gemini.js';
import { endpoint as perplexityEndpoint } from './providers/perplexity.js';
import {
  CLAUDE_PROFILE_VERSION, CLAUDE_SURFACE, CODEX_PROFILE_VERSION, CODEX_SURFACE,
  PROMPT_ENVELOPE_VERSION,
} from './agent-profiles.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').ProviderId} ProviderId */

const API_ROUTES = Object.freeze({
  openai: { route: 'openai-chat-completions-v1', policy: 'off', endpoint: openaiEndpoint, answerTokenLimit: null },
  anthropic: { route: 'anthropic-messages-v1', policy: 'off', endpoint: anthropicEndpoint, answerTokenLimit: anthropicMaxTokens },
  gemini: { route: 'gemini-generate-content-v1', policy: 'off', endpoint: null, answerTokenLimit: null },
  perplexity: { route: 'perplexity-sonar-v1', policy: 'legacy', endpoint: perplexityEndpoint, answerTokenLimit: null },
});

/**
 * The limits Hearsay actually sends or enforces for an existing API route.
 * A null search ceiling means the provider may perform internal searches that
 * this route cannot limit. A null answer ceiling means none is sent.
 *
 * @param {Config} config
 * @param {ProviderId} providerId
 */
export function apiExecutionBudget(config, providerId) {
  const definition = API_ROUTES[providerId];
  const provider = config.providers[providerId];
  assertRoutePolicy(definition.route, `${providerId}-api`, /** @type {import('./measurement-contract.js').SearchPolicy} */ (definition.policy));
  return {
    surface: `${providerId}-api`, route: definition.route, model: provider.model,
    endpoint: providerId === 'gemini' ? geminiEndpointFor(provider.model) : definition.endpoint,
    searchPolicy: definition.policy,
    enabledTools: providerId === 'perplexity' ? ['Sonar internal retrieval'] : [],
    searchUsageAssumption: providerId === 'perplexity' ? 'one_sonar_request' : 'none',
    maxSearchCalls: providerId === 'perplexity' ? null : 0,
    searchCallLimitEnforced: providerId !== 'perplexity',
    maxContinuations: 0,
    timeoutMs: config.timeoutMs,
    answerTokenLimit: definition.answerTokenLimit,
    maxOutputBytes: null,
  };
}

/**
 * The restricted subscription process bounds one invocation but has no reliable
 * internal search-call ceiling or monetary cost cap.
 * @param {Config} config
 * @param {typeof CODEX_SURFACE|typeof CLAUDE_SURFACE} surface
 */
export function subscriptionExecutionBudget(config, surface) {
  const codex = surface === CODEX_SURFACE;
  const route = codex ? 'codex-search-v1' : 'claude-code-search-v1';
  assertRoutePolicy(route, surface, 'required');
  return {
    surface, route, model: 'default', endpoint: null,
    executable: codex ? config.subscription.codex.executable : config.subscription.claudeCode.executable,
    profileVersion: codex ? CODEX_PROFILE_VERSION : CLAUDE_PROFILE_VERSION,
    envelopeVersion: PROMPT_ENVELOPE_VERSION,
    searchPolicy: 'required', enabledTools: ['web search'],
    searchUsageAssumption: 'unknown',
    maxSearchCalls: null, searchCallLimitEnforced: false,
    maxContinuations: 0,
    timeoutMs: config.subscriptionTimeoutMs,
    idleTimeoutMs: config.subscriptionIdleTimeoutMs,
    answerTokenLimit: null,
    maxOutputBytes: config.subscriptionMaxOutputBytes,
  };
}
