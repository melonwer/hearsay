/**
 * Storage — open, migrate, prepared-statement helpers (§3).
 *
 * One SQLite file, WAL mode, `PRAGMA foreign_keys = ON`. All timestamps stored as
 * UTC ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` (§19.6 #5); local time only at render.
 * Schema versioning via `PRAGMA user_version`.
 */

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('node:sqlite').StatementSync} Stmt */
/** Values SQLite accepts as bound parameters (booleans must be stored as 0/1). */
/** @typedef {string|number|bigint|null} SqlValue */
/** @typedef {Record<string, unknown>} Row */

/** Migration 1 — the full v1 schema (§3). */
const SCHEMA_V1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                     -- JSON-encoded
);

CREATE TABLE entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  aliases     TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  domains     TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. ["notewell.io"]
  is_self     INTEGER NOT NULL DEFAULT 0, -- exactly one row is_self=1 (enforced in code)
  created_at  TEXT NOT NULL,
  archived_at TEXT                        -- soft delete; archived entities excluded from metrics
);

CREATE TABLE intents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL UNIQUE,        -- the underlying question
  created_at TEXT NOT NULL
);

CREATE TABLE prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id  INTEGER NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  text       TEXT NOT NULL UNIQUE,        -- one paraphrase of the intent (§6.6)
  category   TEXT NOT NULL DEFAULT 'general', -- 'branded' excluded from SOV denominators (§6.7)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prompts_intent ON prompts(intent_id);
-- Creating a prompt without an intent auto-creates a single-paraphrase intent
-- whose label is the prompt text (enforced in code).

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL CHECK (trigger IN ('cron','manual','api','seed')),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  total_calls INTEGER NOT NULL DEFAULT 0,
  done_calls  INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt_id  INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,               -- 'openai'|'anthropic'|'gemini'|'perplexity'
  model      TEXT NOT NULL,
  sample_idx INTEGER NOT NULL,            -- 0..N-1
  text       TEXT,                        -- null on error
  latency_ms INTEGER,
  tokens_in  INTEGER,                     -- from the provider's usage field (§4.3)
  tokens_out INTEGER,
  cost_usd   REAL,                        -- computed by core/cost.js; null when unknown
  error      TEXT,                        -- error kind + safe detail; never a secret
  created_at TEXT NOT NULL
);
CREATE INDEX idx_responses_run    ON responses(run_id);
CREATE INDEX idx_responses_time   ON responses(created_at);
CREATE INDEX idx_responses_prompt ON responses(prompt_id, provider);

CREATE TABLE mentions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  first_index INTEGER NOT NULL,           -- char offset of first occurrence in responses.text
  occurrences INTEGER NOT NULL DEFAULT 1,
  rank        INTEGER NOT NULL,           -- 1 = first entity mentioned in the answer
  recommended INTEGER NOT NULL DEFAULT 0, -- §6.4 heuristics
  snippet     TEXT NOT NULL               -- ±120 chars of context, original casing
);
CREATE INDEX idx_mentions_response ON mentions(response_id);
CREATE INDEX idx_mentions_entity   ON mentions(entity_id);

CREATE TABLE citations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL,              -- hostname, www-stripped, lowercase
  rank        INTEGER NOT NULL,           -- order of appearance, 1-based
  entity_id   INTEGER                     -- matched via entities.domains, else NULL
);
CREATE INDEX idx_citations_response ON citations(response_id);

CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('good','warning','serious')),
  type         TEXT NOT NULL,             -- LOST_RECOMMENDATION|GAINED_RECOMMENDATION|OVERTAKEN|MENTION_DROP
  entity_id    INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  prompt_id    INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
  provider     TEXT,
  title        TEXT NOT NULL,             -- human sentence, <= 90 chars
  detail       TEXT NOT NULL,             -- 1-3 sentences, with numbers
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_alerts_open ON alerts(acknowledged, created_at);
`;

/**
 * Run the v2 storage migration. SQLite cannot alter a CHECK constraint or make an
 * existing NOT NULL foreign key nullable, so the two affected tables are rebuilt while
 * foreign-key enforcement is temporarily disabled inside this one migration transaction.
 *
 * @param {Db} db
 * @returns {void}
 */
function migrateV2(db) {
  db.exec(`
    ALTER TABLE alerts ADD COLUMN surface TEXT;
    ALTER TABLE responses ADD COLUMN surface TEXT;
    ALTER TABLE responses ADD COLUMN lane TEXT;
    ALTER TABLE responses ADD COLUMN target_status TEXT;
    ALTER TABLE responses ADD COLUMN comparability_status TEXT;
    ALTER TABLE responses ADD COLUMN comparability_reason TEXT;
    ALTER TABLE responses ADD COLUMN web_status TEXT;
    ALTER TABLE responses ADD COLUMN prompt_text_snapshot TEXT;
    ALTER TABLE responses ADD COLUMN prompt_origin TEXT;
    ALTER TABLE responses ADD COLUMN cli_version TEXT;
    ALTER TABLE responses ADD COLUMN execution_profile_hash TEXT;
    ALTER TABLE responses ADD COLUMN prompt_envelope_version TEXT;
    ALTER TABLE responses ADD COLUMN comparison_key TEXT;
    ALTER TABLE responses ADD COLUMN location_control TEXT;
    ALTER TABLE responses ADD COLUMN artifact_ref TEXT;
    ALTER TABLE responses ADD COLUMN safe_error_code TEXT;
  `);

  db.exec(`
    CREATE TABLE prompts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id INTEGER REFERENCES intents(id) ON DELETE CASCADE,
      text TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'general',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      tracking_state TEXT NOT NULL DEFAULT 'tracking'
        CHECK (tracking_state IN ('tracking','exploration')),
      origin TEXT NOT NULL DEFAULT 'legacy'
        CHECK (origin IN ('user_authored','suggested','imported','legacy')),
      approved_at TEXT,
      promoted_at TEXT,
      CHECK (tracking_state = 'tracking' OR (intent_id IS NULL AND active = 0))
    );
    INSERT INTO prompts_v2(id, intent_id, text, category, active, created_at, tracking_state, origin)
      SELECT id, intent_id, text, category, active, created_at, 'tracking', 'legacy'
        FROM prompts;
    DROP TABLE prompts;
    ALTER TABLE prompts_v2 RENAME TO prompts;
    CREATE INDEX idx_prompts_intent ON prompts(intent_id);
    CREATE INDEX idx_prompts_state ON prompts(tracking_state, active);
  `);

  db.exec(`
    CREATE TABLE runs_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual','api','seed')),
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','done','partial','failed','cancelled','missed')),
      total_calls INTEGER NOT NULL DEFAULT 0,
      done_calls INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      schedule_key TEXT,
      schedule_revision_hash TEXT,
      scheduled_for TEXT,
      occurrence_local_date TEXT,
      retry_of_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      target_ceiling INTEGER
    );
    INSERT INTO runs_v2(id, started_at, finished_at, trigger, status, total_calls, done_calls, error)
      SELECT id, started_at, finished_at, trigger, status, total_calls, done_calls, error
        FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_v2 RENAME TO runs;
    CREATE INDEX idx_runs_schedule_occurrence ON runs(schedule_key, occurrence_local_date);
  `);

  db.exec(`
    CREATE TABLE search_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('search','fetch')),
      status TEXT NOT NULL CHECK (status IN ('started','completed','failed','denied','unavailable')),
      query TEXT,
      url TEXT,
      title TEXT,
      domain TEXT,
      observed_at TEXT NOT NULL,
      rank INTEGER,
      provider_event_type TEXT,
      metadata TEXT
    );
    CREATE INDEX idx_search_events_response ON search_events(response_id, event_type, status);
    CREATE INDEX idx_responses_surface ON responses(surface, comparison_key, created_at);
    CREATE INDEX idx_responses_lane ON responses(lane, target_status, comparability_status);
  `);

  const legacyProfileHash = createHash('sha256').update('legacy-api-v1').digest('hex');
  db.exec(`
    UPDATE responses
       SET surface = provider || '-api',
           lane = 'tracking',
           target_status = CASE WHEN error IS NULL THEN 'completed' ELSE 'failed' END,
           comparability_status = 'comparable',
           comparability_reason = NULL,
           web_status = 'not_applicable',
           prompt_text_snapshot = (SELECT text FROM prompts WHERE prompts.id = responses.prompt_id),
           prompt_origin = 'legacy',
           cli_version = NULL,
           execution_profile_hash = '${legacyProfileHash}',
           prompt_envelope_version = 'api-v1',
           comparison_key = 'legacy:' || provider || ':' || model,
           location_control = 'uncontrolled',
           artifact_ref = NULL,
           safe_error_code = CASE WHEN error IS NULL THEN NULL ELSE 'legacy_error' END
     WHERE surface IS NULL;
  `);
}

/** Ordered migrations. Append only — never edit a shipped migration. */
export const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, apply: migrateV2 },
  {
    version: 3,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_schedule_occurrence_unique
      ON runs(schedule_key, occurrence_local_date)
      WHERE trigger = 'cron' AND schedule_key IS NOT NULL AND occurrence_local_date IS NOT NULL;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE responses ADD COLUMN cli_executable TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE execution_profiles (
        id TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE benchmark_revisions (
        id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      ALTER TABLE responses ADD COLUMN execution_profile_id TEXT REFERENCES execution_profiles(id);
      ALTER TABLE responses ADD COLUMN benchmark_revision_id TEXT REFERENCES benchmark_revisions(id);
      ALTER TABLE responses ADD COLUMN analysis_revision TEXT;
      ALTER TABLE responses ADD COLUMN search_policy TEXT
        CHECK (search_policy IN ('off','auto','required','legacy'));
      ALTER TABLE responses ADD COLUMN answer_status TEXT
        CHECK (answer_status IN ('complete','empty','refused','truncated','incomplete','failed'));
      ALTER TABLE responses ADD COLUMN evidence_completeness TEXT
        CHECK (evidence_completeness IN ('complete','partial','unavailable'));
      ALTER TABLE responses ADD COLUMN query_metadata_status TEXT
        CHECK (query_metadata_status IN ('available','unavailable','not_applicable'));
      UPDATE responses SET search_policy = 'legacy';
      CREATE INDEX idx_responses_measurement
        ON responses(execution_profile_id, benchmark_revision_id, analysis_revision, created_at, id);
      CREATE UNIQUE INDEX idx_responses_new_target
        ON responses(run_id, prompt_id, surface, sample_idx)
        WHERE benchmark_revision_id IS NOT NULL;

      ALTER TABLE search_events ADD COLUMN provider_action_id TEXT;
      ALTER TABLE search_events ADD COLUMN sequence INTEGER;
      ALTER TABLE search_events ADD COLUMN safe_error TEXT;
      CREATE INDEX idx_search_events_action
        ON search_events(response_id, provider_action_id, sequence);
      CREATE UNIQUE INDEX idx_search_events_action_unique
        ON search_events(response_id, provider_action_id)
        WHERE provider_action_id IS NOT NULL;

      CREATE TABLE search_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        search_event_id INTEGER REFERENCES search_events(id) ON DELETE SET NULL,
        original_text TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        UNIQUE(response_id, search_event_id, ordinal)
      );
      CREATE INDEX idx_search_queries_scope ON search_queries(response_id, normalized_key);

      CREATE TABLE source_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        search_event_id INTEGER REFERENCES search_events(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        normalized_url TEXT,
        title TEXT,
        excerpt TEXT,
        provenance TEXT NOT NULL CHECK (provenance IN ('search_result','reported_source','fetch')),
        original_order INTEGER
      );
      CREATE INDEX idx_source_observations_scope
        ON source_observations(response_id, provenance, normalized_url);

      CREATE TABLE answer_citations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        source_observation_id INTEGER REFERENCES source_observations(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('native_annotation','explicit_reference','text_link')),
        answer_start INTEGER,
        answer_end INTEGER,
        ordinal INTEGER NOT NULL,
        UNIQUE(response_id, ordinal)
      );
      CREATE INDEX idx_answer_citations_response ON answer_citations(response_id);

      CREATE TABLE usage_components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
        continuation_index INTEGER NOT NULL CHECK (continuation_index >= 0),
        component TEXT NOT NULL,
        quantity REAL,
        unit TEXT NOT NULL,
        cost_usd REAL,
        cost_status TEXT NOT NULL CHECK (cost_status IN ('known','partial','unavailable')),
        price_version TEXT,
        UNIQUE(response_id, attempt_index, continuation_index, component)
      );
      CREATE INDEX idx_usage_components_response ON usage_components(response_id);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE responses ADD COLUMN cost_known_subtotal_usd REAL;
      ALTER TABLE responses ADD COLUMN cost_status TEXT
        CHECK (cost_status IN ('known','partial','unavailable'));
      ALTER TABLE responses ADD COLUMN cost_provenance TEXT
        CHECK (cost_provenance IN ('computed','provider_reported','user_entered'));
      ALTER TABLE responses ADD COLUMN cost_price_version TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE entities ADD COLUMN ambiguous_name INTEGER NOT NULL DEFAULT 0
        CHECK (ambiguous_name IN (0,1));
      CREATE TABLE mention_interpretations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mention_id INTEGER NOT NULL REFERENCES mentions(id) ON DELETE CASCADE,
        analysis_revision TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('positive_stance','legacy_heuristic')),
        stance TEXT CHECK (stance IN ('positive','negative','neutral','uncertain')),
        legacy_recommended INTEGER CHECK (legacy_recommended IN (0,1)),
        rule_id TEXT,
        evidence_start INTEGER,
        evidence_end INTEGER,
        review_flags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(mention_id, analysis_revision),
        CHECK ((method = 'legacy_heuristic' AND stance IS NULL AND legacy_recommended IS NOT NULL
          AND rule_id IS NULL AND evidence_start IS NULL AND evidence_end IS NULL)
          OR (method = 'positive_stance' AND stance IS NOT NULL AND legacy_recommended IS NULL
          AND rule_id IS NOT NULL AND evidence_start IS NOT NULL AND evidence_end > evidence_start))
      );
      CREATE INDEX idx_mention_interpretations_revision
        ON mention_interpretations(analysis_revision, mention_id);
      INSERT INTO mention_interpretations(mention_id, analysis_revision, method,
        legacy_recommended, created_at)
        SELECT m.id, COALESCE(r.analysis_revision, 'legacy-heuristic-v1'),
          'legacy_heuristic', m.recommended, r.created_at
        FROM mentions m JOIN responses r ON r.id = m.response_id;
      CREATE TRIGGER legacy_mention_interpretation AFTER INSERT ON mentions
      WHEN COALESCE((SELECT analysis_revision FROM responses WHERE id = NEW.response_id),
        'legacy-heuristic-v1') = 'legacy-heuristic-v1'
      BEGIN
        INSERT INTO mention_interpretations(mention_id, analysis_revision, method,
          legacy_recommended, created_at)
        SELECT NEW.id, COALESCE(r.analysis_revision, 'legacy-heuristic-v1'),
          'legacy_heuristic', NEW.recommended, r.created_at
        FROM responses r WHERE r.id = NEW.response_id;
      END;
      CREATE TABLE mention_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interpretation_id INTEGER NOT NULL REFERENCES mention_interpretations(id) ON DELETE CASCADE,
        original_value TEXT NOT NULL,
        previous_value TEXT NOT NULL,
        replacement TEXT NOT NULL CHECK (replacement IN ('positive','negative','neutral','uncertain')),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        created_at TEXT NOT NULL,
        predecessor_id INTEGER REFERENCES mention_corrections(id),
        request_id TEXT NOT NULL UNIQUE
      );
      CREATE INDEX idx_mention_corrections_history
        ON mention_corrections(interpretation_id, id);
      CREATE TRIGGER mention_interpretations_no_update BEFORE UPDATE ON mention_interpretations
        BEGIN SELECT RAISE(ABORT, 'interpretations are immutable'); END;
      CREATE TRIGGER mention_corrections_no_update BEFORE UPDATE ON mention_corrections
        BEGIN SELECT RAISE(ABORT, 'corrections are immutable'); END;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE query_themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE query_theme_assignments (
        theme_id INTEGER NOT NULL REFERENCES query_themes(id) ON DELETE CASCADE,
        normalized_key TEXT NOT NULL,
        PRIMARY KEY (theme_id, normalized_key)
      );
      CREATE INDEX idx_query_theme_assignments_key
        ON query_theme_assignments(normalized_key, theme_id);
    `,
  },
];

/** Latest schema version this build knows how to produce. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Create and verify a SQLite-consistent pre-migration backup.
 *
 * @param {Db} db
 * @param {string} dbPath
 * @param {Date} [now]
 * @param {number} [fromVersion]
 * @returns {string|null}
 */
export function createMigrationBackup(db, dbPath, now = new Date(), fromVersion = userVersion(db)) {
  if (dbPath === ':memory:') return null;
  const absolute = resolve(dbPath);
  const dir = dirname(absolute);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const stem = basename(absolute);
  let backupPath = join(dir, `${stem}.migration-${stamp}.v${fromVersion}.db`);
  let suffix = 1;
  while (existsSync(backupPath)) {
    backupPath = join(dir, `${stem}.migration-${stamp}.v${fromVersion}.${suffix}.db`);
    suffix += 1;
  }
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  try {
    chmodSync(backupPath, 0o600);
  } catch {
    // Windows uses user-scoped ACLs; POSIX mode bits are best-effort there.
  }
  const backup = new DatabaseSync(backupPath);
  try {
    const version = Number(backup.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== fromVersion) throw new Error(`Migration backup has schema version ${version}, expected ${fromVersion}`);
    backup.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } finally {
    backup.close();
  }
  return backupPath;
}

/** Setting keys used in v1 (§3). Values are JSON-encoded. */
export const SETTING_KEYS = /** @type {const} */ ({
  /** `"YYYY-MM-DD"` local date of the last scheduled run (§8.2). */
  LAST_SCHEDULED_RUN_DATE: 'last_scheduled_run_date',
  /** Boolean — include `branded` prompts in SOV denominators (§6.7, §11.6). */
  INCLUDE_BRANDED_IN_SOV: 'include_branded_in_sov',
  /** UTC ISO-8601 timestamp of the last demo seed (§12). */
  SEEDED_AT: 'seeded_at',
  /** JSON array of surfaces whose subscription allowance use has been confirmed. */
  SUBSCRIPTION_SURFACE_OPT_IN: 'subscription_surface_opt_in',
  /** JSON-encoded persistent subscription schedule and consent metadata. */
  SUBSCRIPTION_SCHEDULE: 'subscription_schedule',
  /** Explicit consent for the OpenAI web-search route on the existing daily API schedule. */
  API_SEARCH_SCHEDULE: 'api_search_schedule',
});

/** @type {WeakMap<Db, Map<string, Stmt>>} */
const stmtCache = new WeakMap();

/**
 * Prepare (and cache) a statement for a database handle.
 * @param {Db} db
 * @param {string} sql
 * @returns {Stmt}
 */
export function prepare(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit) return hit;
  const stmt = db.prepare(sql);
  cache.set(sql, stmt);
  return stmt;
}

/**
 * @param {Db} db
 * @param {string} sql
 * @param {SqlValue[]} [params]
 * @returns {Row[]}
 */
export function all(db, sql, params = []) {
  return /** @type {Row[]} */ (prepare(db, sql).all(...params));
}

/**
 * @param {Db} db
 * @param {string} sql
 * @param {SqlValue[]} [params]
 * @returns {Row|undefined}
 */
export function get(db, sql, params = []) {
  return /** @type {Row|undefined} */ (prepare(db, sql).get(...params));
}

/**
 * @param {Db} db
 * @param {string} sql
 * @param {SqlValue[]} [params]
 * @returns {{changes: number, lastInsertRowid: number}}
 */
export function run(db, sql, params = []) {
  const result = prepare(db, sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/**
 * Run `fn` inside a transaction, rolling back on throw.
 * @template T
 * @param {Db} db
 * @param {() => T} fn
 * @returns {T}
 */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {Db} db
 * @returns {number}
 */
export function userVersion(db) {
  const row = /** @type {{user_version?: number}|undefined} */ (db.prepare('PRAGMA user_version').get());
  return Number(row?.user_version ?? 0);
}

/**
 * Apply every migration newer than the database's `user_version`.
 * @param {Db} db
 * @returns {number} the resulting schema version
 */
export function migrate(db) {
  let current = userVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const rebuildsTables = migration.version === 2;
    if (rebuildsTables) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      if (typeof migration.apply === 'function') migration.apply(db);
      else db.exec(migration.sql);
      // Not parameterisable; the value is an integer literal from MIGRATIONS.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (rebuildsTables) db.exec('PRAGMA foreign_keys = ON');
      throw err;
    }
    if (rebuildsTables) db.exec('PRAGMA foreign_keys = ON');
    current = migration.version;
  }
  return current;
}

/**
 * Open (creating if needed) the database, set pragmas, and migrate.
 * @param {string} dbPath file path, or ':memory:'
 * @returns {Db}
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const current = userVersion(db);
  if (current > 0 && current < SCHEMA_VERSION) createMigrationBackup(db, dbPath, new Date(), current);
  migrate(db);
  return db;
}

/**
 * Read a setting, JSON-decoded.
 * @template T
 * @param {Db} db
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function getSetting(db, key, fallback) {
  const row = get(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  if (!row || typeof row.value !== 'string') return fallback;
  try {
    return /** @type {T} */ (JSON.parse(row.value));
  } catch {
    return fallback;
  }
}

/**
 * Write a setting, JSON-encoded.
 * @param {Db} db
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
export function setSetting(db, key, value) {
  run(db, 'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    JSON.stringify(value ?? null),
  ]);
}

/**
 * Current time as a UTC ISO-8601 second-precision string, the storage format
 * everywhere in this schema. Pass a date in for determinism in tests/seeding.
 * @param {Date} [date]
 * @returns {string}
 */
export function isoNow(date = new Date()) {
  return `${date.toISOString().slice(0, 19)}Z`;
}
