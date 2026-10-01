/**
 * label-11: embeddings are labeling aids only (duplicate key-point detection, item-to-key-point
 * suggestions), never part of scoring. Static text check: scoring modules must not import from
 * the embeddings layer (relative or via the package export).
 *
 * Direct imports only: the adapter legitimately reaches embeddings transitively through
 * analyzeSessionPipeline (student-side retrieval), which is not scoring.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const OPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCORING_MODULES = ['metric.ts', 'judge.ts', 'adapter.ts', 'gate.ts', 'engine.ts', 'estimate.ts', 'splits.ts', 'label-queue.ts'];

const EMBEDDING_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*(?:\/embeddings\/|\/embeddings['"]|@code-insights\/cli\/embeddings)[^'"]*['"]/;

describe('scoring modules do not import embeddings (label-11)', () => {
  for (const file of SCORING_MODULES) {
    const path = join(OPT_DIR, file);
    it(`${file} has no embeddings import`, () => {
      expect(readFileSync(path, 'utf8')).not.toMatch(EMBEDDING_IMPORT);
    });
  }

  it('the pattern detects the imports it is meant to forbid', () => {
    expect("import { x } from '../embeddings/client.js';").toMatch(EMBEDDING_IMPORT);
    expect("import { x } from '@code-insights/cli/embeddings/store';").toMatch(EMBEDDING_IMPORT);
    expect("const m = await import('../embeddings/retrieval.js');").toMatch(EMBEDDING_IMPORT);
    expect("import { x } from './label-queue.js';").not.toMatch(EMBEDDING_IMPORT);
  });

  it('every scoring module exists and is covered (metric, judge, adapter, gate, engine, splits, label-queue)', () => {
    for (const file of ['metric.ts', 'judge.ts', 'adapter.ts', 'gate.ts', 'engine.ts', 'splits.ts', 'label-queue.ts']) {
      expect(existsSync(join(OPT_DIR, file)), file).toBe(true);
    }
  });
});
