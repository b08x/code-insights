/**
 * Model discovery for CLI runners (plan step 11, found-8).
 *
 * Only runners whose CLI can list models are shelled: `agy models` and `opencode models`. The
 * command and argv are fixed per allowlisted runner name; no request input reaches argv. Any
 * failure (CLI missing, non-zero exit, timeout) yields an empty list so the UI falls back to a
 * free-text model field.
 */

import { execFile } from 'child_process';
import type { AnalysisRunnerName } from '@code-insights/cli/types';

/** Mirrors ANALYSIS_RUNNER_NAMES in @code-insights/cli/types (type-checked below). */
export const RUNNER_NAMES = ['claude', 'codex', 'antigravity', 'vibe', 'opencode', 'provider'] as const satisfies readonly AnalysisRunnerName[];
// Compile-time check that the list covers every AnalysisRunnerName.
type _Exhaustive = Exclude<AnalysisRunnerName, (typeof RUNNER_NAMES)[number]> extends never ? true : never;
const _exhaustive: _Exhaustive = true;
void _exhaustive;

export function isRunnerName(value: unknown): value is AnalysisRunnerName {
  return typeof value === 'string' && (RUNNER_NAMES as readonly string[]).includes(value);
}

const MODEL_LIST_COMMANDS: Partial<Record<AnalysisRunnerName, { cmd: string; args: readonly string[] }>> = {
  antigravity: { cmd: 'agy', args: ['models'] },
  opencode: { cmd: 'opencode', args: ['models'] },
};

export const MODEL_LIST_TIMEOUT_MS = 10_000;

/** Parse one-model-per-line CLI output; tolerates bullets, headers, and trailing descriptions. */
export function parseModelList(stdout: string): string[] {
  const models = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim().replace(/^[-*•]\s+/, '');
    if (!line || line.endsWith(':')) continue;
    const token = line.split(/\s+/)[0];
    if (/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(token)) models.add(token);
  }
  return [...models];
}

/** List models for a runner; empty when the runner has no list command or the call fails. */
export function listRunnerModels(runner: AnalysisRunnerName, timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<string[]> {
  const spec = MODEL_LIST_COMMANDS[runner];
  if (!spec) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      execFile(spec.cmd, [...spec.args], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve([]);
        resolve(parseModelList(String(stdout ?? '')));
      });
    } catch {
      resolve([]);
    }
  });
}
