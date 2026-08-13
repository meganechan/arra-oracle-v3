#!/usr/bin/env bun
/**
 * Non-destructive vector backfill (kobo-52).
 *
 * Embeds ONLY the documents a backend is missing and UPSERTs them — the existing
 * vectors are never touched. This is the safe counterpart to index-model.ts,
 * which hardcodes LanceDB and does deleteCollection() (a destructive full rebuild
 * that, on a pgvector deploy, wipes the wrong backend and fails). Here we honor
 * ORACLE_VECTOR_DB (so it targets pgvector when configured) and only fill the gap.
 *
 * Root cause it fixes: pgvector docs are embedded inline-on-write; docs that
 * predate the switch (or whose inline embed failed) have no vector, and there was
 * no batch tool that honored pgvector to backfill them.
 *
 * Usage:
 *   bun src/scripts/backfill-model.ts bge-m3            # backfill the missing docs
 *   bun src/scripts/backfill-model.ts bge-m3 --dry-run  # report the gap, write nothing
 *
 * Verify authoritatively with an on-host psql COUNT(*) — not muninn_stats (it lags).
 */

import { ensureVectorStoreConnected, getEmbeddingModels } from '../vector/factory.ts';
import { createDatabase } from '../db/index.ts';
import { DB_PATH } from '../config.ts';

export interface DocRow {
  id: string;
  type: string;
  content: string;
  source_file: string;
  concepts: string;
  project: string | null;
  created_at: string;
}

/** Pure: the docs whose id is not yet embedded. Unit-tested (no DB / no Ollama). */
export function docsMissingVectors(all: DocRow[], existing: Iterable<string>): DocRow[] {
  const have = new Set(existing);
  return all.filter((d) => !have.has(d.id));
}

/** All indexer docs joined with their FTS content (same shape index-model.ts uses). */
function readAllDocs(sqlite: import('bun:sqlite').Database): DocRow[] {
  return sqlite
    .prepare(
      `SELECT d.id, d.type, GROUP_CONCAT(f.content, '\n') as content,
              d.source_file, d.concepts, d.project, d.created_at
         FROM oracle_documents d
         JOIN oracle_fts f ON d.id = f.id
        GROUP BY d.id
        ORDER BY d.created_at DESC`,
    )
    .all() as DocRow[];
}

async function main() {
  const modelKey = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const models = getEmbeddingModels();

  if (!modelKey || !models[modelKey]) {
    console.error(`Usage: bun src/scripts/backfill-model.ts <model> [--dry-run]`);
    console.error(`Models: ${Object.keys(models).join(', ')}`);
    process.exit(1);
  }

  const preset = models[modelKey];
  const backend = process.env.ORACLE_VECTOR_DB || 'lancedb';
  console.log(`=== backfill ${modelKey} · backend=${backend}${dryRun ? ' · DRY-RUN' : ''} ===`);
  console.log(`DB: ${DB_PATH} · collection: ${preset.collection}`);

  const store = await ensureVectorStoreConnected(modelKey);

  // Incremental backfill needs to know what's already embedded. If the backend
  // can't answer id-only, we ABORT rather than fall back to a destructive rebuild.
  if (typeof store.existingIds !== 'function') {
    console.error(
      `backend '${backend}' does not support existingIds() — this tool only does ` +
        `safe incremental backfill (pgvector). Aborting instead of risking a wipe.`,
    );
    process.exit(1);
  }

  const { sqlite } = createDatabase(DB_PATH);
  const all = readAllDocs(sqlite);
  const existing = await store.existingIds();
  const missing = docsMissingVectors(all, existing);

  console.log(`docs=${all.length} · embedded=${existing.length} · missing=${missing.length}`);

  if (dryRun) {
    console.log('DRY-RUN — no writes. Re-run without --dry-run to backfill.');
    sqlite.close();
    process.exit(0);
  }
  if (missing.length === 0) {
    console.log('Nothing to backfill — collection already complete.');
    sqlite.close();
    process.exit(0);
  }

  const BATCH = 50;
  let done = 0;
  let errors = 0;
  const t0 = Date.now();

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const docs = batch.map((r) => ({
      id: r.id,
      document: r.content,
      metadata: {
        type: r.type,
        source_file: r.source_file,
        concepts: r.concepts,
        ...(r.project && { project: r.project }),
      },
    }));
    try {
      await store.addDocuments(docs); // UPSERT — never wipes existing rows
      done += docs.length;
      console.log(`  ${done}/${missing.length} embedded`);
    } catch (e) {
      errors++;
      console.error(`  batch @${i} FAILED:`, e instanceof Error ? e.message : String(e));
    }
  }

  const finalCount = (await store.getStats()).count;
  console.log(
    `\n=== done in ${((Date.now() - t0) / 1000).toFixed(1)}s · embedded ${done} · ` +
      `errors ${errors} · collection now ${finalCount} ===`,
  );
  sqlite.close();
  process.exit(errors ? 1 : 0);
}

// Only run when executed directly — importing (e.g. the unit test) must not start a backfill.
if (import.meta.main) {
  main().catch((e) => {
    console.error('backfill failed:', e);
    process.exit(1);
  });
}
