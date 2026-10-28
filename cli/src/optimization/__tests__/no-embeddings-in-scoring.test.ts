/**
 * label-11: embeddings are labeling aids only (duplicate key-point detection, item-to-key-point
 * suggestions), never part of scoring. Static text check: scoring modules must not import from
 * the embeddings layer (relative or via the package export). Modules that do not exist yet are
 * skipped, so the guard is in place before phase 3 adds metric/judge/gate.
 *
 * Direct imports only: the adapter legitimately reaches embeddings transitively through
 * analyzeSessionPipeline (student-side retrieval), which is not scoring.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const OPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCORING_MODULES = ['metric.ts', 'judge.ts', 'gate.ts', 'splits.ts', 'label-queue.ts'];

const EMBEDDING_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*(?:\/embeddings\/|\/embeddings['"]|@code-insights\/cli\/embeddings)[^'"]*['"]/;

describe('scoring modules do not import embeddings (label-11)', () => {
  for (const file of SCORING_MODULES) {
    const path = join(OPT_DIR, file);
    it.skipIf(!existsSync(path))(`${file} has no embeddings import`, () => {
      expect(readFileSync(path, 'utf8')).not.toMatch(EMBEDDING_IMPORT);
    });
  }

  it('the pattern detects the imports it is meant to forbid', () => {
    expect("import { x } from '../embeddings/client.js';").toMatch(EMBEDDING_IMPORT);
    expect("import { x } from '@code-insights/cli/embeddings/store';").toMatch(EMBEDDING_IMPORT);
    expect("const m = await import('../embeddings/retrieval.js');").toMatch(EMBEDDING_IMPORT);
    expect("import { x } from './label-queue.js';").not.toMatch(EMBEDDING_IMPORT);
  });

  it('at least splits.ts and label-queue.ts are covered', () => {
    expect(existsSync(join(OPT_DIR, 'splits.ts'))).toBe(true);
    expect(existsSync(join(OPT_DIR, 'label-queue.ts'))).toBe(true);
  });
});
