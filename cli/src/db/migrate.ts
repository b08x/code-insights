import type Database from 'better-sqlite3';
import { SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from './schema.js';

export interface MigrationResult {
  v6Applied: boolean;
  v7Applied: boolean;
  v8Applied: boolean;
  v9Applied: boolean;
  v10Applied: boolean;
  v11Applied: boolean;
  v12Applied: boolean;
  v13Applied: boolean;
  v14Applied: boolean;
}

/**
 * Apply schema migrations to the database.
 * Called once on startup before any reads or writes.
 *
 * Version 1: Initial schema (projects, sessions, messages, insights, usage_stats)
 * Version 2: Add compound index on insights(confidence DESC, timestamp DESC) for depth-ordered export queries
 * Version 3: Add session_facets table for cross-session analysis
 * Version 4: Add reflect_snapshots table for caching LLM-generated synthesis results
 * Version 5: Add deleted_at column to sessions for soft-delete (user-initiated hide)
 * Version 6: Add compact_count, auto_compact_count, slash_commands columns to sessions
 * Version 7: Add analysis_usage table for tracking LLM analysis costs per session
 * Version 8: Add session_message_count to analysis_usage for resume detection
 * Version 9: Add analysis_queue table for async hook-triggered analysis
 * Version 10: Add parent_session_id and agent_type columns to sessions for subagent hierarchy (Mistral Vibe)
 * Version 11: Add embedding_status to insights and messages, create embedding_metadata table
 * Version 12: Create FTS5 virtual table messages_fts and triggers for full-text search
 */
export function runMigrations(db: Database.Database): MigrationResult {
  // Create schema_version table first if it doesn't exist.
  // This table is created inline (not via SCHEMA_SQL) so migrations can check it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = getCurrentVersion(db);

  if (currentVersion < 1) {
    applyV1(db);
  }

  if (currentVersion < 2) {
    applyV2(db);
  }

  if (currentVersion < 3) {
    applyV3(db);
  }

  if (currentVersion < 4) {
    applyV4(db);
  }

  if (currentVersion < 5) {
    applyV5(db);
  }

  let v6Applied = false;
  if (currentVersion < 6) {
    applyV6(db);
    v6Applied = true;
  }

  let v7Applied = false;
  if (currentVersion < 7) {
    applyV7(db);
    v7Applied = true;
  }

  let v8Applied = false;
  if (currentVersion < 8) {
    applyV8(db);
    v8Applied = true;
  }

  let v9Applied = false;
  if (currentVersion < 9) {
    applyV9(db);
    v9Applied = true;
  }

  let v10Applied = false;
  if (currentVersion < 10) {
    applyV10(db);
    v10Applied = true;
  }

  let v11Applied = false;
  if (currentVersion < 11) {
    applyV11(db);
    v11Applied = true;
  }

  let v12Applied = false;
  if (currentVersion < 12) {
    applyV12(db);
    v12Applied = true;
  }

  let v13Applied = false;
  if (currentVersion < 13) {
    applyV13(db);
    v13Applied = true;
  }

  let v14Applied = false;
  if (currentVersion < 14) {
    applyV14(db);
    v14Applied = true;
  }

  return { v6Applied, v7Applied, v8Applied, v9Applied, v10Applied, v11Applied, v12Applied, v13Applied, v14Applied };
}

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}

function applyV1(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(1);
}

function applyV2(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_insights_confidence_timestamp ON insights(confidence DESC, timestamp DESC)`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(2);
}

function applyV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_facets (
      session_id              TEXT PRIMARY KEY REFERENCES sessions(id),
      outcome_satisfaction    TEXT NOT NULL,
      workflow_pattern        TEXT,
      had_course_correction   INTEGER NOT NULL DEFAULT 0,
      course_correction_reason TEXT,
      iteration_count         INTEGER NOT NULL DEFAULT 0,
      friction_points         TEXT,
      effective_patterns      TEXT,
      extracted_at            TEXT NOT NULL DEFAULT (datetime('now')),
      analysis_version        TEXT NOT NULL DEFAULT '1.0.0'
    );

    CREATE INDEX IF NOT EXISTS idx_facets_outcome ON session_facets(outcome_satisfaction);
    CREATE INDEX IF NOT EXISTS idx_facets_workflow ON session_facets(workflow_pattern);
  `);

  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(3);
}

function applyV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflect_snapshots (
      period        TEXT NOT NULL,
      project_id    TEXT NOT NULL DEFAULT '__all__',
      results_json  TEXT NOT NULL,
      generated_at  TEXT NOT NULL,
      window_start  TEXT,
      window_end    TEXT NOT NULL,
      session_count INTEGER NOT NULL,
      facet_count   INTEGER NOT NULL,
      PRIMARY KEY (period, project_id)
    );
  `);

  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(4);
}

function applyV5(db: Database.Database): void {
  db.exec(`ALTER TABLE sessions ADD COLUMN deleted_at TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(5);
}

function applyV6(db: Database.Database): void {
  db.exec(`ALTER TABLE sessions ADD COLUMN compact_count INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN auto_compact_count INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN slash_commands TEXT NOT NULL DEFAULT '[]'`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(6);
}


function applyV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_usage (
      session_id            TEXT NOT NULL REFERENCES sessions(id),
      analysis_type         TEXT NOT NULL,
      provider              TEXT NOT NULL,
      model                 TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd    REAL NOT NULL DEFAULT 0,
      duration_ms           INTEGER,
      chunk_count           INTEGER NOT NULL DEFAULT 1,
      analyzed_at           TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, analysis_type)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analysis_usage_analyzed_at
      ON analysis_usage(analyzed_at DESC)
  `);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(7);
}
function applyV8(db: Database.Database): void {
  db.exec(`ALTER TABLE analysis_usage ADD COLUMN session_message_count INTEGER`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(8);
}

function applyV9(db: Database.Database): void {
  // analysis_queue: tracks async hook-triggered analysis jobs
  // One row per session (session_id is PK) — retries increment attempt_count in-place
  db.exec(
    `CREATE TABLE IF NOT EXISTS analysis_queue (
      session_id    TEXT PRIMARY KEY REFERENCES sessions(id),
      status        TEXT NOT NULL DEFAULT 'pending',
      runner_type   TEXT NOT NULL DEFAULT 'native',
      enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3
    )`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_analysis_queue_status ON analysis_queue(status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_analysis_queue_enqueued_at ON analysis_queue(enqueued_at ASC)`
  );
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(9);
}

function applyV10(db: Database.Database): void {
  // Add parent_session_id and agent_type for subagent hierarchy support (e.g., Mistral Vibe nested agents)
  // Use try-catch since SQLite doesn't support ALTER TABLE ... IF NOT EXISTS
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN agent_type TEXT`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON sessions(parent_session_id)`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(10);
}

function applyV11(db: Database.Database): void {
  // Add embedding_status to insights and messages for tracking embedding computation state
  try {
    db.exec(`ALTER TABLE insights ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'computed', 'stale', 'failed'))`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'computed', 'stale', 'failed'))`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
  // Index for efficient filtering by embedding status (e.g., "get all pending")
  db.exec(`CREATE INDEX IF NOT EXISTS idx_insights_embedding_status ON insights(embedding_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_embedding_status ON messages(embedding_status)`);
  // Embedding metadata table: tracks model provenance and source text for each computed embedding
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_metadata (
      id            TEXT PRIMARY KEY,
      entity_type   TEXT NOT NULL CHECK(entity_type IN ('insight', 'message')),
      model         TEXT NOT NULL,
      dim           INTEGER NOT NULL,
      source_text   TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_metadata_type ON embedding_metadata(entity_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_metadata_model ON embedding_metadata(model)`);
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(11);
}

function applyV12(db: Database.Database): void {
  // Create FTS5 virtual table for messages
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );
  `);
  
  // Triggers to keep FTS table in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  // Backfill existing messages into FTS
  db.exec(`
    INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
  `);

  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(12);
}

function applyV13(db: Database.Database): void {
  // Drop the old FTS5 virtual table for messages and its triggers
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
  `);

  // Recreate FTS5 virtual table for messages including tool_calls and tool_results
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      tool_calls,
      tool_results,
      content='messages',
      content_rowid='rowid'
    );
  `);
  
  // Triggers to keep FTS table in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, tool_calls, tool_results) VALUES (new.rowid, new.content, new.tool_calls, new.tool_results);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, tool_calls, tool_results) VALUES ('delete', old.rowid, old.content, old.tool_calls, old.tool_results);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, tool_calls, tool_results) VALUES ('delete', old.rowid, old.content, old.tool_calls, old.tool_results);
      INSERT INTO messages_fts(rowid, content, tool_calls, tool_results) VALUES (new.rowid, new.content, new.tool_calls, new.tool_results);
    END;
  `);

  // Backfill existing messages into FTS
  db.exec(`
    INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
  `);

  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(13);
}

function applyV14(db: Database.Database): void {
  // Add entity_chunks table for parent/child RAG
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_chunks (
      id          TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('insight', 'message')),
      entity_id   TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_chunks_entity ON entity_chunks(entity_type, entity_id);`);

  // Add parent_chunk_id and entity_id to embedding_metadata
  try {
    db.exec(`ALTER TABLE embedding_metadata ADD COLUMN parent_chunk_id TEXT`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
  try {
    db.exec(`ALTER TABLE embedding_metadata ADD COLUMN entity_id TEXT NOT NULL DEFAULT ''`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column')) throw e;
  }

  // Set embedding_status of all messages back to 'pending' to force re-chunking
  db.exec(`UPDATE messages SET embedding_status = 'pending'`);
  // And clean up existing metadata for messages (vec_messages will be orphaned/overwritten)
  db.exec(`DELETE FROM embedding_metadata WHERE entity_type = 'message'`);

  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(14);
}
