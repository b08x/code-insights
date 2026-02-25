import { execFile } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';

const DEFAULT_DASHBOARD_URL = 'https://code-insights.app';

interface OpenOptions {
  project?: boolean;
}

/**
 * Open the web dashboard in the default browser.
 */
export async function openCommand(options: OpenOptions): Promise<void> {
  const config = loadConfig();
  const baseUrl = config?.dashboardUrl || DEFAULT_DASHBOARD_URL;

  let url = baseUrl;

  // If --project flag, try to detect current project name from cwd
  if (options.project) {
    const projectName = getCurrentProjectName();
    if (projectName) {
      url = `${baseUrl}/sessions?project=${encodeURIComponent(projectName)}`;
    }
  }

  console.log(chalk.cyan(`\n  Opening ${url}\n`));

  try {
    openInBrowser(url);
  } catch {
    console.log(chalk.yellow('  Could not open browser automatically.'));
    console.log(chalk.white(`  Visit: ${chalk.bold.underline(url)}\n`));
  }
}

/**
 * Open a URL in the default browser using platform-specific commands.
 * Uses execFile (not exec) to prevent shell injection.
 */
function openInBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', [url]);
  } else if (platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url]);
  } else {
    execFile('xdg-open', [url]);
  }
}

/**
 * Get the current directory name as a project name guess.
 */
function getCurrentProjectName(): string | null {
  try {
    const cwd = process.cwd();
    const parts = cwd.split('/');
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}
