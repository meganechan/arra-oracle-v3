import { expect, test } from 'bun:test';
import { docsMissingVectors, type DocRow } from './backfill-model.ts';

const doc = (id: string): DocRow => ({
  id,
  type: 'learning',
  content: 'x',
  source_file: 'f.md',
  concepts: '',
  project: null,
  created_at: '2026-07-03',
});

test('returns only docs not already embedded', () => {
  const missing = docsMissingVectors([doc('a'), doc('b'), doc('c')], ['a', 'c']);
  expect(missing.map((d) => d.id)).toEqual(['b']);
});

test('empty existing → everything is missing', () => {
  expect(docsMissingVectors([doc('a'), doc('b')], []).map((d) => d.id)).toEqual(['a', 'b']);
});

test('all embedded (plus extra ids) → nothing missing', () => {
  expect(docsMissingVectors([doc('a')], ['a', 'z']).length).toBe(0);
});

test('does not mutate the input array', () => {
  const all = [doc('a'), doc('b')];
  docsMissingVectors(all, ['a']);
  expect(all.length).toBe(2);
});
