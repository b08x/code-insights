import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { ensureConfigDir, getClaudeDir, getConfigDir } from './config.js';

const WELCOME_MARKER = '.welcome-shown';

/**
 * Show a one-time welcome banner for first-time users.
 *
 * Only fires when no ~/.code-insights/.welcome-shown marker exists.
 * Intentionally non-critical — all file I/O is wrapped so errors
 * are swallowed silently rather than interrupting the user's command.
 *
 * Returns true if the banner was printed, false if already shown.
 */
export function showWelcomeIfFirstRun(): boolean {
  try {
    const markerPath = path.join(getConfigDir(), WELCOME_MARKER);

    // Already greeted this user — bail out fast
    if (fs.existsSync(markerPath)) {
      return false;
    }

    const { sessionCount, projectCount } = countClaudeSessions();

    console.log('');
    console.log(chalk.bold.cyan('  Welcome to Code Insights!'));
    console.log('');

    if (sessionCount > 0) {
      console.log(
        chalk.dim('  Found ') +
        chalk.white.bold(sessionCount) +
        chalk.dim(` session${sessionCount === 1 ? '' : 's'} across `) +
        chalk.white.bold(projectCount) +
        chalk.dim(` project${projectCount === 1 ? '' : 's'} in ~/.claude/projects`)
      );
    } else {
      console.log(chalk.dim('  No sessions found yet in ~/.claude/projects'));
    }

    console.log('');

    // Touch the marker so we never show this again
    touchWelcomeMarker(markerPath);

    return true;
  } catch {
    // Welcome is non-critical — swallow all errors silently
    return false;
  }
}

/**
 * Count JSONL sessions and project directories in ~/.claude/projects/.
 * Mirrors the discovery logic in ClaudeCodeProvider without pulling in
 * the full provider dependency chain.
 */
function countClaudeSessions(): { sessionCount: number; projectCount: number } {
  const baseDir = getClaudeDir();

  if (!fs.existsSync(baseDir)) {
    return { sessionCount: 0, projectCount: 0 };
  }

  let sessionCount = 0;
  let projectCount = 0;

  try {
    const entries = fs.readdirSync(baseDir);

    for (const entry of entries) {
      // Skip hidden files/dirs (matches ClaudeCodeProvider behaviour)
      if (entry.startsWith('.')) continue;

      const entryPath = path.join(baseDir, entry);

      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      projectCount++;

      try {
        const files = fs.readdirSync(entryPath);
        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            sessionCount++;
          }
        }
      } catch {
        // Can't read this project dir — skip it, keep counting others
      }
    }
  } catch {
    return { sessionCount: 0, projectCount: 0 };
  }

  return { sessionCount, projectCount };
}

/**
 * Create the welcome-shown marker file.
 * Ensures the config directory exists first (handles brand-new installs
 * where no config has been written yet).
 */
function touchWelcomeMarker(markerPath: string): void {
  ensureConfigDir();
  fs.writeFileSync(markerPath, '', { mode: 0o600 });
}
