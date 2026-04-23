// ═══════════════════════════════════════════
// SQLite database layer for scope-guard-mcp
// DB path: ~/.scope-guard-mcp/scope.db
// ═══════════════════════════════════════════

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DB_DIR = join(homedir(), '.scope-guard-mcp');
const DB_PATH = join(DB_DIR, 'scope.db');

// Ensure directory exists
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ─────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS scopes (
    scope_id           TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL,
    allowed_files_json TEXT NOT NULL DEFAULT '[]',
    allowed_tools_json TEXT NOT NULL DEFAULT '[]',
    restrictions_json  TEXT NOT NULL DEFAULT '{}',
    created_at         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scopes_agent_id ON scopes(agent_id);

  CREATE TABLE IF NOT EXISTS violations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id       TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    violation_type TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '',
    timestamp      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_violations_agent_id   ON violations(agent_id);
  CREATE INDEX IF NOT EXISTS idx_violations_scope_id   ON violations(scope_id);
`);

// ─── Prepared statements ─────────────────────

const stmts = {
  upsertScope: db.prepare(`
    INSERT INTO scopes (scope_id, agent_id, allowed_files_json, allowed_tools_json, restrictions_json, created_at)
    VALUES (@scope_id, @agent_id, @allowed_files_json, @allowed_tools_json, @restrictions_json, @created_at)
    ON CONFLICT(scope_id) DO UPDATE SET
      allowed_files_json = excluded.allowed_files_json,
      allowed_tools_json = excluded.allowed_tools_json,
      restrictions_json  = excluded.restrictions_json
  `),

  getScopeByAgent: db.prepare(`
    SELECT * FROM scopes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1
  `),

  getAllScopes: db.prepare(`SELECT * FROM scopes ORDER BY created_at DESC`),

  insertViolation: db.prepare(`
    INSERT INTO violations (scope_id, agent_id, violation_type, detail, timestamp)
    VALUES (@scope_id, @agent_id, @violation_type, @detail, @timestamp)
  `),

  getViolationsByAgent: db.prepare(`
    SELECT * FROM violations WHERE agent_id = ? ORDER BY timestamp DESC
  `),

  getAllViolations: db.prepare(`SELECT * FROM violations ORDER BY timestamp DESC`),

  countViolationsByAgent: db.prepare(`
    SELECT COUNT(*) as cnt FROM violations WHERE agent_id = ?
  `),
};

// ─── Public API ──────────────────────────────

/**
 * Upsert a scope row. restrictions_json holds any extra fields
 * (forbidden_tools, max_delegations, description, delegation_count, etc.)
 */
export function dbUpsertScope(scopeId, agentId, allowedFiles, allowedTools, restrictions, createdAt) {
  stmts.upsertScope.run({
    scope_id:           scopeId,
    agent_id:           agentId,
    allowed_files_json: JSON.stringify(allowedFiles),
    allowed_tools_json: JSON.stringify(allowedTools),
    restrictions_json:  JSON.stringify(restrictions),
    created_at:         createdAt,
  });
}

/**
 * Fetch the most-recent scope row for an agent.
 * Returns a parsed object or null.
 */
export function dbGetScope(agentId) {
  const row = stmts.getScopeByAgent.get(agentId);
  return row ? parseScope(row) : null;
}

/**
 * Return all scope rows, parsed.
 */
export function dbGetAllScopes() {
  return stmts.getAllScopes.all().map(parseScope);
}

/**
 * Record a violation.
 */
export function dbInsertViolation(scopeId, agentId, violationType, detail) {
  stmts.insertViolation.run({
    scope_id:       scopeId,
    agent_id:       agentId,
    violation_type: violationType,
    detail:         detail || '',
    timestamp:      new Date().toISOString(),
  });
}

/**
 * Return all violation rows for an agent.
 */
export function dbGetViolationsByAgent(agentId) {
  return stmts.getViolationsByAgent.all(agentId);
}

/**
 * Return all violation rows.
 */
export function dbGetAllViolations() {
  return stmts.getAllViolations.all();
}

/**
 * Count violations for a given agent.
 */
export function dbCountViolations(agentId) {
  return stmts.countViolationsByAgent.get(agentId).cnt;
}

// ─── Helpers ─────────────────────────────────

function parseScope(row) {
  return {
    scope_id:      row.scope_id,
    agent_id:      row.agent_id,
    allowed_files: JSON.parse(row.allowed_files_json),
    allowed_tools: JSON.parse(row.allowed_tools_json),
    restrictions:  JSON.parse(row.restrictions_json),
    created_at:    row.created_at,
  };
}

export { db };
