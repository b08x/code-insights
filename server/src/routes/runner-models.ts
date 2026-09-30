/**
 * Model discovery for CLI runners (plan step 11, found-8).
 *
 * Only runners whose CLI can list models are shelled: `agy models` and `opencode models`. The
 * command and argv are fixed per allowlisted runner name; no request input reaches argv. Any
 * failure (CLI missing, non-zero exit, timeout) yields an empty list so the UI falls back to a
 * free-text model field.
 */

import { execFile } from 'child_process';
import { ANALYSIS_RUNNER_NAMES, isRunnerName, type AnalysisRunnerName } from '@code-insights/cli/utils/runner-setting';

export { ANALYSIS_RUNNER_NAMES, isRunnerName };

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
