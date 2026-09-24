import { assertRoutePolicy } from './measurement-contract.js';
import { endpoint as openaiEndpoint, responsesEndpoint as openaiResponsesEndpoint } from './providers/openai.js';
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
  const searchPolicy = config.apiSearchPolicies[providerId];
  const definition = providerId === 'openai' && searchPolicy !== 'off'
    ? { route: 'openai-responses-web-search-v1', policy: searchPolicy,
      endpoint: openaiResponsesEndpoint, answerTokenLimit: 2048 }
    : providerId === 'anthropic' && searchPolicy === 'auto'
      ? { route: 'anthropic-messages-web-search-v1', policy: searchPolicy,
        endpoint: anthropicEndpoint, answerTokenLimit: anthropicMaxTokens }
    : API_ROUTES[providerId];
  const provider = config.providers[providerId];
  if (providerId === 'openai' && searchPolicy !== 'off' && provider.model !== 'gpt-5.6-luna') {
    throw new RangeError(`OpenAI web search is not validated for ${provider.model}`);
  }
  if (providerId === 'anthropic' && searchPolicy === 'auto' && provider.model !== 'claude-sonnet-5') {
    throw new RangeError(`Anthropic web search is not validated for ${provider.model}`);
  }
  assertRoutePolicy(definition.route, `${providerId}-api`, /** @type {import('./measurement-contract.js').SearchPolicy} */ (definition.policy));
  return {
    surface: `${providerId}-api`, route: definition.route, model: provider.model,
    endpoint: providerId === 'gemini' ? geminiEndpointFor(provider.model) : definition.endpoint,
    searchPolicy: definition.policy,
    enabledTools: providerId === 'perplexity' ? ['Sonar internal retrieval']
      : providerId === 'openai' && searchPolicy !== 'off' ? ['web_search']
        : providerId === 'anthropic' && searchPolicy === 'auto' ? ['web_search_20250305'] : [],
    searchUsageAssumption: providerId === 'perplexity' ? 'one_sonar_request'
      : (providerId === 'openai' && searchPolicy !== 'off' || providerId === 'anthropic' && searchPolicy === 'auto')
        ? 'one_web_search_call_per_target_forecast' : 'none',
    maxSearchCalls: providerId === 'anthropic' && searchPolicy === 'auto' ? 3
      : providerId === 'perplexity' || providerId === 'openai' && searchPolicy !== 'off' ? null : 0,
    searchCallLimitEnforced: providerId !== 'perplexity' && !(providerId === 'openai' && searchPolicy !== 'off'),
    maxContinuations: providerId === 'anthropic' && searchPolicy === 'auto' ? 1 : 0,
    timeoutMs: config.timeoutMs,
    answerTokenLimit: definition.answerTokenLimit,
    maxOutputBytes: (providerId === 'openai' && searchPolicy !== 'off' || providerId === 'anthropic' && searchPolicy === 'auto')
      ? 2 * 1024 * 1024 : null,
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
