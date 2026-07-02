/**
 * Unit tests for markSuperseded — the shared id-form write used by BOTH the
 * local MCP handler and the HTTP route (POST /api/supersede/mark). Guards the
 * fix where the remote-proxy path hit the legacy log route and never wrote
 * oracle_documents.superseded_by.
 *
 * Hermetic: :memory: SQLite, no vector store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../db/schema.ts';
import { markSuperseded } from '../supersede.ts';
import type { ToolContext } from '../types.ts';

const DOCS_SCHEMA = `
CREATE TABLE oracle_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  concepts TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  superseded_reason TEXT,
  origin TEXT,
  project TEXT,
  created_by TEXT
);
`;

let sqlite: Database;
let db: ToolContext['db'];

function insertDoc(id: string, type = 'learning'): void {
  const now = Date.now();
  sqlite.query(
    `INSERT INTO oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?)`,
  ).run(id, type, `ψ/${id}.md`, now, now, now);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(DOCS_SCHEMA);
  db = drizzle(sqlite, { schema });
});

afterEach(() => {
  try { sqlite.close(); } catch {}
});

describe('markSuperseded', () => {
  it('sets superseded_by/at/reason on the old doc and returns both types', () => {
    insertDoc('old-1', 'learning');
    insertDoc('new-1', 'pattern');

    const res = markSuperseded(db, { oldId: 'old-1', newId: 'new-1', reason: 'dedup' });
    expect(res.oldType).toBe('learning');
    expect(res.newType).toBe('pattern');

    const row = sqlite.query(
      'SELECT superseded_by, superseded_at, superseded_reason FROM oracle_documents WHERE id = ?',
    ).get('old-1') as { superseded_by: string; superseded_at: number; superseded_reason: string };
    expect(row.superseded_by).toBe('new-1');
    expect(row.superseded_reason).toBe('dedup');
    expect(row.superseded_at).toBe(res.supersededAt);

    // new doc untouched
    const newRow = sqlite.query('SELECT superseded_by FROM oracle_documents WHERE id = ?').get('new-1') as { superseded_by: string | null };
    expect(newRow.superseded_by).toBeNull();
  });

  it('null reason when omitted', () => {
    insertDoc('old-2');
    insertDoc('new-2');
    markSuperseded(db, { oldId: 'old-2', newId: 'new-2' } as any);
    const row = sqlite.query('SELECT superseded_reason FROM oracle_documents WHERE id = ?').get('old-2') as { superseded_reason: string | null };
    expect(row.superseded_reason).toBeNull();
  });

  it('throws when old doc is missing (no write)', () => {
    insertDoc('new-3');
    expect(() => markSuperseded(db, { oldId: 'nope', newId: 'new-3' } as any)).toThrow(/Old document not found/);
  });

  it('throws when new doc is missing', () => {
    insertDoc('old-4');
    expect(() => markSuperseded(db, { oldId: 'old-4', newId: 'nope' } as any)).toThrow(/New document not found/);
  });
});
