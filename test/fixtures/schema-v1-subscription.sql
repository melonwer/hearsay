PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  domains TEXT NOT NULL DEFAULT '[]',
  is_self INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id INTEGER NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  text TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'general',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prompts_intent ON prompts(intent_id);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual','api','seed')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  total_calls INTEGER NOT NULL DEFAULT 0,
  done_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  sample_idx INTEGER NOT NULL,
  text TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_responses_run ON responses(run_id);
CREATE INDEX idx_responses_time ON responses(created_at);
CREATE INDEX idx_responses_prompt ON responses(prompt_id, provider);
CREATE TABLE mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  first_index INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  rank INTEGER NOT NULL,
  recommended INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL
);
CREATE INDEX idx_mentions_response ON mentions(response_id);
CREATE INDEX idx_mentions_entity ON mentions(entity_id);
CREATE TABLE citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  rank INTEGER NOT NULL,
  entity_id INTEGER
);
CREATE INDEX idx_citations_response ON citations(response_id);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK (severity IN ('good','warning','serious')),
  type TEXT NOT NULL,
  entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  prompt_id INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
  provider TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_alerts_open ON alerts(acknowledged, created_at);

INSERT INTO entities(id, name, aliases, domains, is_self, created_at) VALUES
  (1, 'Acme', '["Acme AI"]', '["acme.example"]', 1, '2026-08-01T07:00:00Z'),
  (2, 'Rival', '[]', '["rival.example"]', 0, '2026-08-01T07:00:00Z');
INSERT INTO intents(id, label, created_at) VALUES
  (1, 'best meeting notes tool', '2026-08-01T07:00:00Z');
INSERT INTO prompts(id, intent_id, text, category, active, created_at) VALUES
  (1, 1, 'What is the best meeting notes tool?', 'general', 1, '2026-08-01T07:00:00Z');
INSERT INTO runs(id, started_at, finished_at, trigger, status, total_calls, done_calls, error) VALUES
  (1, '2026-08-02T07:00:00Z', '2026-08-02T07:01:00Z', 'seed', 'done', 1, 1, NULL);
INSERT INTO responses(id, run_id, prompt_id, provider, model, sample_idx, text, latency_ms, tokens_in, tokens_out, cost_usd, error, created_at) VALUES
  (1, 1, 1, 'openai', 'gpt-test', 0, 'Acme is a good option.', 100, 10, 20, 0.01, NULL, '2026-08-02T07:01:00Z'),
  (2, 1, 1, 'anthropic', 'claude-test', 1, NULL, NULL, NULL, NULL, NULL, 'timeout: test', '2026-08-02T07:01:01Z');
INSERT INTO mentions(response_id, entity_id, first_index, occurrences, rank, recommended, snippet) VALUES
  (1, 1, 0, 1, 1, 1, 'Acme is a good option.');
INSERT INTO citations(response_id, url, domain, rank, entity_id) VALUES
  (1, 'https://acme.example/pricing', 'acme.example', 1, 1);
INSERT INTO alerts(created_at, run_id, severity, type, entity_id, prompt_id, provider, title, detail, acknowledged) VALUES
  ('2026-08-02T07:02:00Z', 1, 'warning', 'MENTION_DROP', 1, 1, 'openai', 'Acme mention drop', '1 of 1 answers', 0);

PRAGMA user_version = 1;
