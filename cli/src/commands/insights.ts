/**
 * insights command — analyze a session using configured LLM or a native CLI runner.
 *
 * Modes:
 *   --native / --codex / --claude / --antigravity / --vibe / --opencode   Native CLI runners (user's subscription)
 *   (default)  Use configured LLM provider (OpenAI, Anthropic, Gemini, Ollama, ...)
 *
 * All analysis logic lives in analysis/pipeline.ts (analyzeSessionPipeline). This command only
 * selects a runner, handles hook-mode resume detection, converts pipeline failures into thrown
 * errors, and renders the report.
 *
 * Hook mode (--hook):
 *   Reads { session_id, transcript_path, cwd } from stdin JSON,
 *   calls syncSingleFile() to guarantee fresh data, then analyzes.
 *
 * Resume detection (hook mode only):
 *   Skips analysis if analysis_usage.session_message_count matches current
 *   sessions.message_count — the session has not changed since last analysis.
 *   Bypassed with --force.
 */

import chalk from 'chalk';
import { getDb } from '../db/client.js';
import { loadConfig } from '../utils/config.js';
import { renderAnalysisReport } from '../analysis/render.js';
import { ClaudeNativeRunner } from '../analysis/native-runner.js';
import { CodexNativeRunner } from '../analysis/codex-runner.js';
import { ProviderRunner } from '../analysis/provider-runner.js';
import { analyzeSessionPipeline, pipelineFailureToError } from '../analysis/pipeline.js';
import { FallbackNativeRunner } from '../analysis/native-fallback.js';
import type { AnalysisRunner } from '../analysis/runner-types.js';
import { buildRunner, configuredRunner, runnerConfigFor, selectRunner, type AnalysisRunnerName } from '../analysis/runner-selection.js';

// ── Resume detection ──────────────────────────────────────────────────────────

function loadSessionMessageCount(sessionId: string): number | undefined {
  const row = getDb().prepare(
    'SELECT message_count FROM sessions WHERE id = ? AND deleted_at IS NULL'
  ).get(sessionId) as { message_count: number } | undefined;
  return row?.message_count;
}

function isAlreadyAnalyzed(sessionId: string, currentMessageCount: number): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_message_count FROM analysis_usage
    WHERE session_id = ? AND analysis_type = 'session'
  `).get(sessionId) as { session_message_count: number | null } | undefined;

  if (!row) return false;
  return row.session_message_count === currentMessageCount;
}

// ── Command options ───────────────────────────────────────────────────────────

export interface InsightsCommandOptions {
  sessionId: string;
  native: boolean;
  codex?: boolean;
  claude?: boolean;
  antigravity?: boolean;
  vibe?: boolean;
  opencode?: boolean;
  hookMode?: boolean;
  force?: boolean;
  quiet?: boolean;
  source?: string;
  format?: string;
  /** Pre-built runner to reuse across batch calls. Skips runner construction and validate(). */
  _runner?: AnalysisRunner;
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function runInsightsCommand(options: InsightsCommandOptions): Promise<string | void> {
  const format = options.format ?? 'rich';
  const log = options.quiet ? () => {} : console.log.bind(console);

  // 1. Build the runner (or reuse a pre-built one from batch callers)
  let runner: AnalysisRunner;
  // Explicit runner flags win; else the runner saved in Settings; else plain --native's
  // Codex -> Claude default; else the configured provider.
  const selection = options._runner ? null : selectRunner(options, loadConfig());
  if (options._runner) {
    runner = options._runner;
  } else if (selection) {
    runner = buildRunner(selection.name, selection.runnerConfig);
  } else if (options.native) {
    // Default native is Codex, falling back to Claude
    try {
      CodexNativeRunner.validate();
      runner = new CodexNativeRunner();
    } catch {
      try {
        ClaudeNativeRunner.validate();
        runner = new ClaudeNativeRunner();
      } catch {
        throw new Error(`No native runners found. --native requires either Codex or Claude Code to be installed.`);
      }
    }
  } else {
    runner = ProviderRunner.fromConfig();
  }

  // General 'native' mode (not forced to one specific runner) gets the multi-level fallback.
  if (options.native && !options.codex && !options.antigravity && !options.vibe) {
    runner = new FallbackNativeRunner(runner, log);
  }

  // 2. Session must exist; hook mode skips sessions unchanged since the last analysis.
  const messageCount = loadSessionMessageCount(options.sessionId);
  if (messageCount === undefined) {
    throw new Error(`Session '${options.sessionId}' not found in local database.`);
  }
  if (options.hookMode && !options.force && isAlreadyAnalyzed(options.sessionId, messageCount)) {
    return; // already analyzed at this session length
  }

  // 3. One pipeline for every entry point (session pass + prompt-quality pass).
  const result = await analyzeSessionPipeline(options.sessionId, {
    runner,
    log: message => log(chalk.dim(`[Code Insights] ${message}`)),
  });

  if (!result.success) {
    throw pipelineFailureToError(result);
  }

  // ── Render report ──────────────────────────────────────────────────────────

  const sessionAnalysis = result.session!;
  const { meta } = result;

  if (format === 'json') {
    // Return raw JSON so batch callers can parse and render
    return JSON.stringify({
      session: sessionAnalysis,
      promptQuality: result.promptQuality,
      meta: {
        model: meta.model,
        durationMs: meta.durationMs,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        messageCount: meta.messageCount,
        projectName: meta.projectName,
      },
    });
  }

  log(renderAnalysisReport({
    sessionAnalysis,
    pqAnalysis: result.promptQuality,
    model: meta.model,
    durationMs: meta.durationMs,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    messageCount: meta.messageCount,
    projectName: meta.projectName,
  }));
}

// ── CLI command entry point ───────────────────────────────────────────────────

export async function insightsCommand(
  sessionId: string | undefined,
  opts: {
    native?: boolean;
    codex?: boolean;
    claude?: boolean;
    antigravity?: boolean;
    vibe?: boolean;
  opencode?: boolean;
    hook?: boolean;
    source?: string;
    force?: boolean;
    quiet?: boolean;
    format?: string;
  }
): Promise<void> {
  const quiet = opts.quiet ?? opts.format === 'quiet';
  const format = opts.format ?? 'rich';
  const log = quiet ? () => {} : console.log.bind(console);

  try {
    let resolvedSessionId: string;

    if (opts.hook) {
      // Hook mode: read { session_id, transcript_path, cwd } from stdin
      const stdinData = await readStdin();
      let parsed: { session_id?: string; transcript_path?: string; cwd?: string };
      try {
        parsed = JSON.parse(stdinData);
      } catch {
        throw new Error('--hook mode requires valid JSON on stdin (got: ' + stdinData.slice(0, 100) + ')');
      }

      if (!parsed.session_id) {
        throw new Error('--hook stdin JSON missing required field: session_id');
      }

      resolvedSessionId = parsed.session_id;

      // Sync the single file before analysis
      if (parsed.transcript_path) {
        const { syncSingleFile } = await import('./sync.js');
        await syncSingleFile({ filePath: parsed.transcript_path, sourceTool: opts.source, quiet });
      }
    } else {
      if (!sessionId) {
        throw new Error('Session ID is required (or use --hook to read from stdin)');
      }
      resolvedSessionId = sessionId;
    }

    await runInsightsCommand({
      sessionId: resolvedSessionId,
      native: opts.native ?? false,
      codex: opts.codex ?? false,
      claude: opts.claude ?? false,
      antigravity: opts.antigravity ?? false,
      vibe: opts.vibe ?? false,
      opencode: opts.opencode ?? false,
      hookMode: opts.hook ?? false,
      force: opts.force ?? false,
      quiet,
      source: opts.source,
      format,
    });
  } catch (error) {
    if (!quiet) {
      console.error(chalk.red(`[Code Insights] ${error instanceof Error ? error.message : 'Analysis failed'}`));
    }
    process.exit(1);
  }
}

// ── Subcommand: insights check ────────────────────────────────────────────────

// Seconds per session estimate (15-30s each; use 22s as mid-range)
const SECONDS_PER_SESSION = 22;

export async function insightsCheckCommand(opts: {
  days?: number;
  quiet?: boolean;
  analyze?: boolean;
  native?: boolean;
  codex?: boolean;
  claude?: boolean;
  antigravity?: boolean;
  vibe?: boolean;
  opencode?: boolean;
}): Promise<void> {
  const days = opts.days ?? 7;
  const quiet = opts.quiet ?? false;
  const analyze = opts.analyze ?? false;
  const log = quiet ? () => {} : console.log.bind(console);

  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT s.id, s.generated_title, s.custom_title, s.started_at, s.message_count
      FROM sessions s
      LEFT JOIN analysis_usage au ON au.session_id = s.id AND au.analysis_type = 'session'
      WHERE s.started_at >= ?
        AND s.deleted_at IS NULL
        AND au.session_id IS NULL
      ORDER BY s.started_at DESC
    `).all(cutoff) as Array<{ id: string; generated_title: string | null; custom_title: string | null; started_at: string; message_count: number }>;

    const count = rows.length;

    if (count === 0) {
      // Silent — all sessions analyzed
      return;
    }

    if (quiet) {
      process.stdout.write(String(count) + '\n');
      return;
    }

    // --analyze: process all found sessions with progress output
    if (analyze || count <= 2) {
      let runner: AnalysisRunner | undefined;
      type RunnerType = AnalysisRunnerName;

      const checkConfig = loadConfig();
      const initializeRunner = (type: RunnerType): AnalysisRunner | undefined => {
        try {
          // Saved model/variant apply only when `type` is the runner saved in Settings.
          return buildRunner(type, runnerConfigFor(type, checkConfig));
        } catch (err) {
          log(chalk.yellow(`[Code Insights] ${type} runner not available: ${err instanceof Error ? err.message : String(err)}`));
          return undefined;
        }
      };
      // Runner used when no runner flag is given: the one saved in Settings, else the provider.
      const defaultRunnerType: RunnerType = configuredRunner(checkConfig)?.name ?? 'provider';

      if (analyze) {
        // Determine initial runner type
        let currentRunnerType: RunnerType;
        if (opts.antigravity) {
          currentRunnerType = 'antigravity';
        } else if (opts.codex) {
          currentRunnerType = 'codex';
        } else if (opts.claude) {
          currentRunnerType = 'claude';
        } else if (opts.vibe) {
          currentRunnerType = 'vibe';
        } else if (opts.opencode) {
          currentRunnerType = 'opencode';
        } else if (opts.native) {
          currentRunnerType = 'codex';
        } else {
          currentRunnerType = defaultRunnerType;
        }

        runner = initializeRunner(currentRunnerType);

        // Fallback logic for native modes: Claude -> Codex -> Antigravity -> Vibe
        if (!runner && (opts.native || opts.codex || opts.antigravity || opts.vibe)) {
          // If we started with claude or provider (as default for --native), try Codex
          if (currentRunnerType === 'claude' || (opts.native && !opts.codex && !opts.antigravity && !opts.vibe)) {
            log(chalk.yellow(`[Code Insights] Falling back to Codex...`));
            currentRunnerType = 'codex';
            runner = initializeRunner('codex');
          }
          // If we still have no runner and were trying codex (or just started there), try Antigravity
          if (!runner && currentRunnerType === 'codex') {
            log(chalk.yellow(`[Code Insights] Falling back to Antigravity...`));
            currentRunnerType = 'antigravity';
            runner = initializeRunner('antigravity');
          }
          // If we still have no runner and were trying antigravity, try Vibe
          if (!runner && currentRunnerType === 'antigravity') {
            log(chalk.yellow(`[Code Insights] Falling back to Mistral Vibe...`));
            currentRunnerType = 'vibe';
            runner = initializeRunner('vibe');
          }
        }

        if (!runner) {
          throw new Error(`No runners could be initialized. Please check your configuration or tool availability.`);
        }

        let successCount = 0;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const label = row.custom_title ?? row.generated_title ?? row.id;
          const position = `[${i + 1}/${count}]`;
          process.stdout.write(`${position} ${label} ... `);
          const start = Date.now();
          try {
            const report = await runInsightsCommand({ 
              sessionId: row.id, 
              native: currentRunnerType === 'codex' || currentRunnerType === 'claude' || currentRunnerType === 'antigravity' || currentRunnerType === 'vibe',
              codex: currentRunnerType === 'codex', 
              claude: currentRunnerType === 'claude',
              antigravity: currentRunnerType === 'antigravity',
              vibe: currentRunnerType === 'vibe',
              quiet: true, 
              _runner: runner,
              format: 'json',
            });
            const elapsed = Math.round((Date.now() - start) / 1000);
            process.stdout.write(`done (${elapsed}s)\n`);
            if (report) {
              try {
                const parsed = JSON.parse(report);
                console.log(renderAnalysisReport({
                  sessionAnalysis: parsed.session,
                  pqAnalysis: parsed.promptQuality,
                  model: parsed.meta?.model,
                  durationMs: parsed.meta?.durationMs,
                  inputTokens: parsed.meta?.inputTokens,
                  outputTokens: parsed.meta?.outputTokens,
                  messageCount: parsed.meta?.messageCount,
                  projectName: parsed.meta?.projectName,
                }));
              } catch { /* report not JSON, skip */ }
            }
            successCount++;
          } catch (err: any) {
            process.stdout.write('failed\n');
            console.error(chalk.red(`  [Code Insights] ${err instanceof Error ? err.message : 'Analysis failed'}`));
          }
        }

        log(chalk.green(`Analyzed ${successCount} session${successCount !== 1 ? 's' : ''}.`));
        return;
      }

      // Auto-analyze silently when 1-2 unanalyzed sessions
      if (count <= 2) {
        let runnerType: RunnerType;
        if (opts.antigravity) runnerType = 'antigravity';
        else if (opts.codex) runnerType = 'codex';
        else if (opts.claude) runnerType = 'claude';
        else if (opts.vibe) runnerType = 'vibe';
        else if (opts.opencode) runnerType = 'opencode';
        else if (opts.native) runnerType = 'codex';
        else runnerType = defaultRunnerType;

        runner = initializeRunner(runnerType);
        
        // Fallback for auto-analyze
        if (!runner && (opts.native || opts.codex || opts.antigravity || opts.vibe)) {
          if (runnerType === 'claude' || (opts.native && !opts.codex && !opts.antigravity && !opts.vibe)) {
            runnerType = 'codex';
            runner = initializeRunner('codex');
          }
          if (!runner && runnerType === 'codex') {
            runnerType = 'antigravity';
            runner = initializeRunner('antigravity');
          }
          if (!runner && runnerType === 'antigravity') {
            runnerType = 'vibe';
            runner = initializeRunner('vibe');
          }
        }

        if (runner) {
          for (const row of rows) {
            try {
              const report = await runInsightsCommand({ 
                sessionId: row.id, 
                native: runnerType === 'codex' || runnerType === 'claude' || runnerType === 'antigravity' || runnerType === 'vibe',
                codex: runnerType === 'codex',
                claude: runnerType === 'claude',
                antigravity: runnerType === 'antigravity',
                vibe: runnerType === 'vibe',
                quiet: true,
                _runner: runner,
                format: 'json',
              });
              if (report) {
                try {
                  const parsed = JSON.parse(report);
                  console.log(renderAnalysisReport({
                    sessionAnalysis: parsed.session,
                    pqAnalysis: parsed.promptQuality,
                    model: parsed.meta?.model,
                    durationMs: parsed.meta?.durationMs,
                    inputTokens: parsed.meta?.inputTokens,
                    outputTokens: parsed.meta?.outputTokens,
                    messageCount: parsed.meta?.messageCount,
                    projectName: parsed.meta?.projectName,
                  }));
                } catch { /* report not JSON, skip */ }
              }
            } catch {
              // Silently ignore auto-analyze errors for 1-2 sessions
            }
          }
          return;
        }
      }
    }

    // 3-10: print count + suggestion
    if (count <= 10) {
      log(chalk.yellow(`[Code Insights] ${count} unanalyzed session${count > 1 ? 's' : ''} in the last ${days} days.`));
      log(chalk.dim(`  Run: code-insights insights check --analyze to process them`));
      return;
    }

    // 11+: print count + time estimate
    const estimateSecs = count * SECONDS_PER_SESSION;
    const estimateMins = Math.round(estimateSecs / 60);
    const timeLabel = estimateMins < 2 ? `~${estimateSecs}s` : `~${estimateMins} min`;
    log(chalk.yellow(`[Code Insights] ${count} unanalyzed session${count > 1 ? 's' : ''} in the last ${days} days.`));
    log(chalk.dim(`  Estimated time: ${timeLabel} (~${SECONDS_PER_SESSION}s each)`));
    log(chalk.dim(`  Run: code-insights insights check --analyze to process them`));
  } catch (error) {
    if (!quiet) {
      console.error(chalk.red(`[Code Insights] ${error instanceof Error ? error.message : 'Check failed'}`));
    }
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('{}');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}
