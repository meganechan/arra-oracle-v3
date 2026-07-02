/**
 * POST /api/supersede/mark — id-form supersede.
 *
 * Sets oracle_documents.superseded_by/at/reason by document ID (the write the
 * MCP proxy needs). The legacy POST /api/supersede only appends to supersede_log
 * and requires old_path — the remote-proxy client used to hit it and got a 400,
 * so supersede was unusable over ORACLE_REMOTE_URL. This route reuses the exact
 * same core write as the local MCP handler (markSuperseded).
 */

import { Elysia } from 'elysia';
import { db } from '../../db/index.ts';
import { markSuperseded } from '../../tools/supersede.ts';

export const supersedeMarkEndpoint = new Elysia().post(
  '/supersede/mark',
  ({ body, set }) => {
    const data = (body ?? {}) as Record<string, any>;
    const oldId = data.old_id ?? data.oldId;
    const newId = data.new_id ?? data.newId;
    if (!oldId || !newId) {
      set.status = 400;
      return { error: 'Missing required field: old_id and new_id' };
    }

    try {
      const { oldType, newType, supersededAt } = markSuperseded(db, {
        oldId,
        newId,
        reason: data.reason,
      });
      return {
        success: true,
        old_id: oldId,
        old_type: oldType,
        new_id: newId,
        new_type: newType,
        reason: data.reason ?? null,
        superseded_at: new Date(supersededAt).toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      set.status = /not found/i.test(msg) ? 404 : 500;
      return { error: msg };
    }
  },
  {
    detail: {
      tags: ['supersede'],
      menu: { group: 'hidden' },
      summary: 'Mark supersede by id (writes oracle_documents.superseded_by)',
    },
  },
);
