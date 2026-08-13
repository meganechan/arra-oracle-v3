/**
 * Oracle Supersede Handler
 *
 * Mark old documents as superseded by newer ones.
 * "Nothing is Deleted" — old doc preserved but marked outdated.
 */

import { eq } from 'drizzle-orm';
import { oracleDocuments } from '../db/schema.ts';
import type { ToolContext, ToolResponse, OracleSupersededInput } from './types.ts';

export const supersedeToolDef = {
  name: 'muninn_supersede',
  description: 'Mark an old learning/document as superseded by a newer one. Aligns with "Nothing is Deleted" - old doc preserved but marked outdated.',
  inputSchema: {
    type: 'object',
    properties: {
      oldId: {
        type: 'string',
        description: 'ID of the document being superseded (the outdated one)'
      },
      newId: {
        type: 'string',
        description: 'ID of the document that supersedes it (the current one)'
      },
      reason: {
        type: 'string',
        description: 'Why the old document is outdated (optional)'
      }
    },
    required: ['oldId', 'newId']
  }
};

/**
 * Core id-form supersede write: validate both docs exist, then set
 * oracle_documents.superseded_by/at/reason on the old doc. Shared by the local
 * MCP handler (handleSupersede) and the HTTP route (POST /api/supersede/mark) so
 * both write paths stay identical — the remote-proxy path previously hit the
 * legacy log route instead and never touched superseded_by.
 */
export function markSuperseded(
  db: ToolContext['db'],
  input: OracleSupersededInput,
): { oldType: string | null; newType: string | null; supersededAt: number } {
  const { oldId, newId, reason } = input;
  const now = Date.now();

  const oldDoc = db.select({ id: oracleDocuments.id, type: oracleDocuments.type })
    .from(oracleDocuments)
    .where(eq(oracleDocuments.id, oldId))
    .get();
  const newDoc = db.select({ id: oracleDocuments.id, type: oracleDocuments.type })
    .from(oracleDocuments)
    .where(eq(oracleDocuments.id, newId))
    .get();

  if (!oldDoc) throw new Error(`Old document not found: ${oldId}`);
  if (!newDoc) throw new Error(`New document not found: ${newId}`);

  db.update(oracleDocuments)
    .set({
      supersededBy: newId,
      supersededAt: now,
      supersededReason: reason || null,
    })
    .where(eq(oracleDocuments.id, oldId))
    .run();

  console.error(`[SUPERSEDE] ${oldId} → superseded by → ${newId}`);
  return { oldType: oldDoc.type, newType: newDoc.type, supersededAt: now };
}

/**
 * Attach superseded_by/at/reason to search hits (P-001 "Nothing is Deleted" —
 * superseded docs remain searchable; callers need the flag to decide whether to
 * follow the replacement pointer). Shared by the MCP-local search (tools/search)
 * and the HTTP search handler, which is what the remote-proxy MCP path reads —
 * without it a superseded doc comes back over ORACLE_REMOTE_URL with no flag.
 */
export function attachSupersedeFlags(
  sqlite: ToolContext['sqlite'],
  results: Array<Record<string, any>>,
): void {
  if (results.length === 0) return;
  const ids = results.map(r => r.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const rows = sqlite.prepare(`
    SELECT id, superseded_by, superseded_at, superseded_reason
    FROM oracle_documents
    WHERE id IN (${placeholders}) AND superseded_by IS NOT NULL
  `).all(...ids) as Array<{
    id: string;
    superseded_by: string;
    superseded_at: number;
    superseded_reason: string | null;
  }>;
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const r of results) {
    const s = byId.get(r.id as string);
    if (s) {
      r.superseded_by = s.superseded_by;
      r.superseded_at = new Date(s.superseded_at).toISOString();
      r.superseded_reason = s.superseded_reason;
    }
  }
}

export async function handleSupersede(ctx: ToolContext, input: OracleSupersededInput): Promise<ToolResponse> {
  const { oldId, newId, reason } = input;
  const { oldType, newType, supersededAt } = markSuperseded(ctx.db, input);
  const now = supersededAt;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        old_id: oldId,
        old_type: oldType,
        new_id: newId,
        new_type: newType,
        reason: reason || null,
        superseded_at: new Date(now).toISOString(),
        message: `"${oldId}" is now marked as superseded by "${newId}". It will still appear in search results (P-001 Nothing is Deleted), now flagged with "superseded_by", "superseded_at", and "superseded_reason" fields so callers can follow the replacement pointer.`
      }, null, 2)
    }]
  };
}
