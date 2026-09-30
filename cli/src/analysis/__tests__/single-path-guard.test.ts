/**
 * Single-path guard (plan step 12): session analysis has exactly one orchestration.
 *
 * buildSessionAnalysisInstructions (prompt) and parseAnalysisResponse (output parser) may only be
 * referenced by their defining modules, analyzeSessionPipeline, pure re-export shims, and the
 * GEPA adapter (which must evaluate through the same formatter -> runner -> parser path).
 * Anything else means a second pipeline is growing back. Static text check, no execution.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOTS = ['cli/src', 'server/src', 'dashboard/src'];
const GUARDED = ['buildSessionAnalysisInstructions', 'parseAnalysisResponse'] as const;

/** Files allowed to mention a guarded symbol, with why. Paths are repo-relative, posix style. */
const ALLOWED: Record<string, string> = {
  'cli/src/analysis/prompts.ts': 'defines buildSessionAnalysisInstructions',
  'cli/src/analysis/response-parsers.ts': 'defines parseAnalysisResponse',
  'cli/src/analysis/pipeline.ts': 'analyzeSessionPipeline, the single orchestration',
  'server/src/llm/prompts.ts': 're-export shim (verified below: no call sites)',
  'server/src/llm/response-parsers.ts': 're-export shim (verified below: no call sites)',
  // The GEPA adapter (plan step 15) is the only other sanctioned consumer.
  'cli/src/optimization/gepa-adapter.ts': 'GEPA adapter evaluates through the same path',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === '__fixtures__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const repoPath = (abs: string) => relative(REPO_ROOT, abs).split(sep).join('/');

describe('single analysis path guard', () => {
  const files = SCAN_ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)));

  it('scans a plausible source tree', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(repoPath)).toContain('cli/src/analysis/pipeline.ts');
  });

  it('no module outside the allowlist references buildSessionAnalysisInstructions / parseAnalysisResponse', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const path = repoPath(file);
      if (path in ALLOWED) continue;
      const text = readFileSync(file, 'utf-8');
      for (const symbol of GUARDED) {
        if (new RegExp(`\\b${symbol}\\b`).test(text)) offenders.push(`${path} references ${symbol}`);
      }
    }
    expect(offenders, 'second analysis pipeline? route it through analyzeSessionPipeline').toEqual([]);
  });

  it('re-export shims never call the guarded functions', () => {
    for (const [path, why] of Object.entries(ALLOWED)) {
      if (!why.startsWith('re-export shim')) continue;
      const text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      for (const symbol of GUARDED) {
        expect(text, `${path} must only re-export ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\s*\\(`));
      }
    }
  });

  it('the pipeline itself uses both (guard is not vacuous)', () => {
    const text = readFileSync(join(REPO_ROOT, 'cli/src/analysis/pipeline.ts'), 'utf-8');
    for (const symbol of GUARDED) expect(text).toMatch(new RegExp(`\\b${symbol}\\s*\\(`));
  });
});
