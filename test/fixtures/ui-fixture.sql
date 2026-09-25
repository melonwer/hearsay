-- Web-lane UI fixture (§19 Lane C): the smallest database that makes every page render
-- something real, so a render test can assert on data rather than on chrome.
--
--   entities   1 Notewell (brand, is_self)   2 Larkspur   3 Tessellate   — all fictional
--   intent 1   two paraphrases (§6.6), so the "one wording" nudge is not what shows
--   run 1      trigger 'seed' (§19.6 #3: fabricated rows live only under this trigger)
--   responses  3 answers + 1 stored error, with mentions and citations
--   alerts     one open MENTION_DROP, numbers included in the detail (§9)
--
-- Timestamps are relative to `now` so the rows stay inside the 30-day window the pages
-- report on, and are written UTC ISO-8601 second-precision (§19.6 #5).
-- `first_index` and `snippet` are the real offsets and context of each match (§6.2).

INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES
  (1, 'Notewell',   '["Note Well"]',  '["notewell.example"]',   1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days')),
  (2, 'Larkspur',   '["Larkspur AI"]','["larkspur.example"]',   0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days')),
  (3, 'Tessellate', '[]',             '["tessellate.example"]', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days'));

INSERT INTO intents(id, label, created_at) VALUES
  (1, 'Best AI meeting-notes tool for a small sales team', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days'));

INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES
  (1, 1, 'What is the best AI meeting-notes tool for a small sales team?', 'general', 1,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days')),
  (2, 1, 'Which AI note taker do small sales teams actually recommend?', 'general', 1,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 days'));

INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls) VALUES
  (1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days'),
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days', '+4 minutes'), 'seed', 'done', 4, 4);

INSERT INTO responses(id, run_id, prompt_id, provider, model, sample_idx, text,
                      latency_ms, tokens_in, tokens_out, cost_usd, error, created_at) VALUES
  (1, 1, 1, 'openai', 'gpt-5.6-luna', 0,
      'For a small sales team, Notewell is the one most reviewers land on, with Larkspur a close second if you also need call scoring.',
      1240, 180, 260, 0.0021, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days')),
  (2, 1, 1, 'anthropic', 'claude-sonnet-5', 0,
      'Larkspur is the usual recommendation for larger teams; Tessellate is cheaper but thinner on integrations.',
      1510, 176, 208, 0.0018, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days', '+1 minutes')),
  (3, 1, 2, 'gemini', 'gemini-3.6-flash', 0,
      'If you want AI meeting notes without the admin, I would recommend Notewell — it is the one small teams stick with.',
      980, 165, 231, 0.0006, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days', '+2 minutes')),
  (4, 1, 2, 'perplexity', 'sonar', 0, NULL,
      NULL, NULL, NULL, NULL, 'timeout: no answer within 45000 ms',
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days', '+3 minutes'));

UPDATE responses SET
  surface = provider || '-api', lane = 'tracking',
  target_status = CASE WHEN error IS NULL THEN 'completed' ELSE 'failed' END,
  comparability_status = 'comparable', web_status = 'not_applicable',
  comparison_key = 'fixture:' || provider, search_policy = 'legacy',
  analysis_revision = 'legacy-heuristic-v1',
  answer_status = CASE WHEN error IS NULL THEN 'complete' ELSE 'failed' END;

INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES
  (1, 1, 24, 1, 1, 0,
      'For a small sales team, Notewell is the one most reviewers land on, with Larkspur a close second if you also need call scoring.'),
  (1, 2, 73, 1, 2, 0,
      'For a small sales team, Notewell is the one most reviewers land on, with Larkspur a close second if you also need call scoring.'),
  (2, 2, 0, 1, 1, 1,
      'Larkspur is the usual recommendation for larger teams; Tessellate is cheaper but thinner on integrations.'),
  (2, 3, 55, 1, 2, 0,
      'Larkspur is the usual recommendation for larger teams; Tessellate is cheaper but thinner on integrations.'),
  (3, 1, 66, 1, 1, 1,
      'If you want AI meeting notes without the admin, I would recommend Notewell — it is the one small teams stick with.');

INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES
  (1, 'https://notewell.example/pricing',        'notewell.example',   1, 1),
  (1, 'https://roundup.example/ai-note-takers',  'roundup.example',    2, NULL),
  (2, 'https://larkspur.example/for-teams',      'larkspur.example',   1, 2),
  (2, 'https://tessellate.example/compare',      'tessellate.example', 2, 3),
  (3, 'https://roundup.example/ai-note-takers',  'roundup.example',    1, NULL);

INSERT INTO alerts(created_at, run_id, severity, type, entity_id, prompt_id, provider, surface, title, detail, acknowledged) VALUES
  (strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days', '+5 minutes'), 1, 'warning', 'MENTION_DROP', 1, 1, 'openai', 'openai-api',
   'Notewell mention rate fell on ChatGPT',
   'Notewell was mentioned in 1 of 3 ChatGPT answers for this prompt, down from 3 of 3 in the previous run.', 0);
