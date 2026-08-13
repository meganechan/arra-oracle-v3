/**
 * POST /api/supersede — append to legacy supersede_log table.
 *
 * Kept for backwards compatibility; the MCP write path populates
 * oracle_documents.superseded_by directly, not this table. Callers that want the
 * document actually flagged (and shown as such in search) want
 * POST /api/supersede/mark — this route's 201 says "logged", nothing more.
 */

import { Elysia } from 'elysia';
import { db, supersedeLog } from '../../db/index.ts';
import { SupersedeBody } from './model.ts';

export const supersedeCreateEndpoint = new Elysia().post(
  '/supersede',
  ({ body, set }) => {
    try {
      const data = (body ?? {}) as Record<string, any>;
      if (!data.old_path) {
        set.status = 400;
        return { error: 'Missing required field: old_path' };
      }

      const result = db.insert(supersedeLog).values({
        oldPath: data.old_path,
        oldId: data.old_id || null,
        oldTitle: data.old_title || null,
        oldType: data.old_type || null,
        newPath: data.new_path || null,
        newId: data.new_id || null,
        newTitle: data.new_title || null,
        reason: data.reason || null,
        supersededAt: Date.now(),
        supersededBy: data.superseded_by || 'user',
        project: data.project || null,
      }).returning({ id: supersedeLog.id }).get();

      set.status = 201;
      return {
        id: result.id,
        message: 'Supersession logged',
        // This route only appends to supersede_log; nothing reads that table and
        // search flags come from oracle_documents.superseded_by. Say so, or a
        // caller reads 201 as "the old doc is now closed" (it is not).
        warning: 'Logged only — the document was NOT flagged. Use POST /api/supersede/mark with old_id/new_id to set superseded_by (what search shows).',
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },
  {
    body: SupersedeBody,
    detail: {
      tags: ['supersede'],
      menu: { group: 'hidden' },
      summary: 'Append to legacy supersede_log',
    },
  },
);
