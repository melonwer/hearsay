import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConfig } from '../core/config.js';
import { apiExecutionBudget, subscriptionExecutionBudget } from '../core/execution-budget.js';

test('existing API budgets preserve search-off routes and identify Sonar internal retrieval', () => {
  const config = buildConfig({ OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test',
    GEMINI_API_KEY: 'test', PERPLEXITY_API_KEY: 'test' });
  const openai = apiExecutionBudget(config, 'openai');
  const anthropic = apiExecutionBudget(config, 'anthropic');
  const gemini = apiExecutionBudget(config, 'gemini');
  const sonar = apiExecutionBudget(config, 'perplexity');
  assert.deepEqual([openai.searchPolicy, openai.enabledTools, openai.maxSearchCalls,
    openai.searchCallLimitEnforced, openai.maxContinuations], ['off', [], 0, true, 0]);
  assert.equal(openai.searchUsageAssumption, 'none');
  assert.equal(openai.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(anthropic.answerTokenLimit, 1024);
  assert.match(String(gemini.endpoint), /gemini-3\.6-flash:generateContent$/);
  assert.deepEqual([sonar.searchPolicy, sonar.enabledTools, sonar.maxSearchCalls,
    sonar.searchCallLimitEnforced], ['legacy', ['Sonar internal retrieval'], null, false]);
  assert.equal(sonar.searchUsageAssumption, 'one_sonar_request');
});

test('subscription budgets expose bounded process output and an unenforceable internal search count', () => {
  const config = buildConfig({ HEARSAY_CODEX_ENABLED: '1', HEARSAY_CLAUDE_CODE_ENABLED: '1',
    HEARSAY_SUBSCRIPTION_TIMEOUT_MS: '90000' });
  for (const surface of /** @type {const} */ (['codex-agent', 'claude-code-agent'])) {
    const budget = subscriptionExecutionBudget(config, surface);
    assert.equal(budget.searchPolicy, 'required');
    assert.equal(budget.searchUsageAssumption, 'unknown');
    assert.equal(budget.maxSearchCalls, null);
    assert.equal(budget.searchCallLimitEnforced, false);
    assert.equal(budget.maxContinuations, 0);
    assert.equal(budget.timeoutMs, 90000);
    assert.equal(budget.maxOutputBytes, 2 * 1024 * 1024);
    assert.equal(budget.answerTokenLimit, null);
  }
});
