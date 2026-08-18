import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { trackEvent, captureError, classifyError } from '../utils/telemetry.js';

const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_HOOKS_FILE = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');

const VIBE_SETTINGS_DIR = path.join(os.homedir(), '.vibe');
const VIBE_HOOKS_FILE = path.join(VIBE_SETTINGS_DIR, 'hooks.toml');

// Stable path to the CLI entry point — works across npm link, global install, and npx.
// process.argv[1] is unstable (npx uses a cache path that changes per invocation).
const CLI_ENTRY = path.resolve(fileURLToPath(import.meta.url), '../../index.js');

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: HookConfig[];
    Stop?: HookConfig[];
    SessionEnd?: HookConfig[];
    [key: string]: HookConfig[] | undefined;
  };
  [key: string]: unknown;
}

interface HookConfig {
  matcher?: string;
  hooks: Array<string | { type: string; command?: string; url?: string; timeout?: number }>;
}

export interface InstallHookOptions {
  syncOnly?: boolean;
  analysisOnly?: boolean;
  runner?: string;
  target?: string;
}

/** Extract command string from both old (string) and new ({type, command}) hook formats */
function getHookCommand(hook: string | { type: string; command?: string; url?: string } | null | undefined): string {
  if (!hook) return '';
  if (typeof hook === 'string') return hook;
  return hook.command || '';
}

/** Check if a hook array already contains a code-insights hook */
function hookAlreadyInstalled(hookList: HookConfig[]): boolean {
  return hookList.some(
    (h) => h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
  );
}

/**
 * Install hooks for auto-sync and native session analysis.
 *
 * Supports target='claude' (default) and target='vibe'.
 */
export async function installHookCommand(options: InstallHookOptions = {}): Promise<void> {
  const { target = 'claude' } = options;

  if (target === 'vibe') {
    return installVibeHookCommand(options);
  } else if (target === 'opencode') {
    return installOpenCodeHookCommand(options);
  }

  return installClaudeHookCommand(options);
}

async function installClaudeHookCommand(options: InstallHookOptions): Promise<void> {
  const { syncOnly = false, analysisOnly = false, runner = 'native' } = options;

  if (syncOnly && analysisOnly) {
    console.log(chalk.red('Cannot use --sync-only and --analysis-only together. Use neither flag to install both hooks.'));
    return;
  }

  const installSync = !analysisOnly;
  const installAnalysis = !syncOnly;

  console.log(chalk.cyan('\nInstall Code Insights Hooks (Claude Code)\n'));

  try {
    const syncCommand = `node ${CLI_ENTRY} sync -q`;
    const analysisCommand = `node ${CLI_ENTRY} session-end --source claude-code --${runner} -q`;

    if (!syncOnly && !analysisOnly) {
      console.log(chalk.gray('This will add two Claude Code hooks:\n'));
      console.log(chalk.white('  Stop hook         — Syncs sessions after each response'));
      console.log(chalk.white(`  SessionEnd hook   — Analyzes sessions using --${runner}`));
      console.log(chalk.gray('                      No API key needed. (~15-30s per session)\n'));
    } else if (syncOnly) {
      console.log(chalk.gray(`This will add a Stop hook: ${syncCommand}\n`));
    } else {
      console.log(chalk.gray(`This will add a SessionEnd hook: ${analysisCommand}\n`));
    }

    // Load existing settings
    let settings: ClaudeSettings = {};
    if (fs.existsSync(CLAUDE_HOOKS_FILE)) {
      try {
        const content = fs.readFileSync(CLAUDE_HOOKS_FILE, 'utf-8');
        settings = JSON.parse(content);
      } catch {
        console.log(chalk.yellow('Could not parse existing settings.json, creating new one.'));
      }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    let syncInstalled = false;
    let analysisInstalled = false;

    // Install Stop hook (sync)
    if (installSync) {
      const existingStopHooks = settings.hooks.Stop || [];
      if (!hookAlreadyInstalled(existingStopHooks)) {
        const stopHook: HookConfig = {
          hooks: [{ type: 'command', command: syncCommand }],
        };
        settings.hooks.Stop = [...existingStopHooks, stopHook];
        syncInstalled = true;
      }
    }

    // Install SessionEnd hook (analysis)
    if (installAnalysis) {
      const existingSessionEndHooks = settings.hooks.SessionEnd || [];
      if (!hookAlreadyInstalled(existingSessionEndHooks)) {
        const sessionEndHook: HookConfig = {
          hooks: [{ type: 'command', command: analysisCommand, timeout: 300000 }],
        };
        settings.hooks.SessionEnd = [...existingSessionEndHooks, sessionEndHook];
        analysisInstalled = true;
      }
    }

    if (!syncInstalled && !analysisInstalled) {
      // Both requested hooks were already present — show a single consolidated message
      const label = installSync && installAnalysis ? 'sync + analysis' : installSync ? 'sync' : 'analysis';
      console.log(chalk.yellow(`Code Insights hooks already installed (${label}).`));
      console.log(chalk.gray('To reinstall, first run `code-insights uninstall-hook`'));
      return;
    }

    // Write settings
    fs.mkdirSync(CLAUDE_SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(CLAUDE_HOOKS_FILE, JSON.stringify(settings, null, 2));

    const installedTypes: string[] = [];
    if (syncInstalled) installedTypes.push('sync');
    if (analysisInstalled) installedTypes.push('analysis');

    console.log(chalk.green('Hook installed successfully!'));
    console.log(chalk.gray(`\nConfiguration saved to: ${CLAUDE_HOOKS_FILE}`));

    if (!analysisOnly) {
      console.log(chalk.cyan('\nHow it works:'));
      console.log(chalk.white('  Stop hook: sessions are synced after each Claude response'));
    }
    if (!syncOnly) {
      console.log(chalk.white('  SessionEnd hook: sessions are analyzed when a session ends'));
      console.log(chalk.white('  No API key needed — uses your Claude Code subscription'));
    }

    trackEvent('cli_install_hook', {
      success: true,
      target: 'claude',
      hook_types: installedTypes.join(','),
      sync_installed: syncInstalled,
      analysis_installed: analysisInstalled,
    });
  } catch (error) {
    console.log(chalk.red(`Failed to install hook: ${error instanceof Error ? error.message : 'Unknown error'}`));
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_install_hook', { success: false, target: 'claude', error_type, error_message });
    captureError(error, { command: 'install_hook', target: 'claude', error_type });
  }
}

async function installVibeHookCommand(options: InstallHookOptions): Promise<void> {
  const { runner = 'native' } = options;

  console.log(chalk.cyan('\nInstall Code Insights Hook (Mistral Vibe)\n'));

  try {
    const hookCommand = `node ${CLI_ENTRY} session-end --source mistral-vibe --${runner} -q`;

    let existing = '';
    if (fs.existsSync(VIBE_HOOKS_FILE)) {
      existing = fs.readFileSync(VIBE_HOOKS_FILE, 'utf-8');
    }

    if (existing.includes('code-insights')) {
      console.log(chalk.yellow('Code Insights hook already installed for Mistral Vibe.'));
      console.log(chalk.gray('To reinstall, first run `code-insights uninstall-hook --target vibe`'));
      return;
    }

    console.log(chalk.gray('This will add a post_agent hook to Vibe:'));
    console.log(chalk.white(`  Command: ${hookCommand}`));
    console.log(chalk.gray('  It runs after each agent turn to sync and queue analysis.\n'));

    const newHook = `\n[[hooks]]\nname = "code-insights-session-end"\ntype = "post_agent"\ncommand = "${hookCommand.replace(/\\/g, '\\\\')}"\ntimeout = 300.0\ndescription = "Analyzes sessions using Code Insights"\n`;

    fs.mkdirSync(VIBE_SETTINGS_DIR, { recursive: true });
    fs.appendFileSync(VIBE_HOOKS_FILE, newHook);

    console.log(chalk.green('Hook installed successfully!'));
    console.log(chalk.gray(`\nConfiguration saved to: ${VIBE_HOOKS_FILE}`));

    trackEvent('cli_install_hook', {
      success: true,
      target: 'vibe',
      hook_types: 'analysis'
    });
  } catch (error) {
    console.log(chalk.red(`Failed to install hook: ${error instanceof Error ? error.message : 'Unknown error'}`));
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_install_hook', { success: false, target: 'vibe', error_type, error_message });
    captureError(error, { command: 'install_hook', target: 'vibe', error_type });
  }
}

async function installOpenCodeHookCommand(options: InstallHookOptions): Promise<void> {
  const { runner = 'native' } = options;

  console.log(chalk.cyan('\nInstall Code Insights Hook (OpenCode)\n'));

  try {
    const OPENCODE_DIR = path.join(os.homedir(), '.config', 'opencode');
    const OPENCODE_PLUGINS_DIR = path.join(OPENCODE_DIR, 'plugins');
    const pluginPath = path.join(OPENCODE_PLUGINS_DIR, 'code-insights.ts');

    if (fs.existsSync(pluginPath)) {
      console.log(chalk.yellow('Code Insights hook already installed for OpenCode.'));
      console.log(chalk.gray('To reinstall, first run `code-insights uninstall-hook --target opencode`'));
      return;
    }

    console.log(chalk.gray('This will add a code-insights.ts plugin to OpenCode:'));
    console.log(chalk.gray('  It listens to the session.idle event to sync and queue analysis.\n'));

    const hookContent = `// code-insights-hook:start
import { spawn } from 'node:child_process';

const BIN = '${CLI_ENTRY}';

export const CodeInsights = async () => ({
  'session.idle': async (input: any) => {
    return new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'session-end', '--source', 'opencode', '--${runner}', '-q'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env },
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      child.stdin.end(JSON.stringify({
        session_id: input?.session?.id || input?.sessionId || input?.id || null,
      }));
    });
  }
});
// code-insights-hook:end
`;

    fs.mkdirSync(OPENCODE_PLUGINS_DIR, { recursive: true });
    fs.writeFileSync(pluginPath, hookContent, 'utf-8');

    console.log(chalk.green('Hook installed successfully!'));
    console.log(chalk.gray(`\nConfiguration saved to: ${pluginPath}`));

    trackEvent('cli_install_hook', {
      success: true,
      target: 'opencode',
      hook_types: 'analysis'
    });
  } catch (error) {
    console.log(chalk.red(`Failed to install hook: ${error instanceof Error ? error.message : 'Unknown error'}`));
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_install_hook', { success: false, target: 'opencode', error_type, error_message });
    captureError(error, { command: 'install_hook', target: 'opencode', error_type });
  }
}

/**
 * Uninstall hooks — removes Code Insights hooks from Claude Code or Mistral Vibe.
 */
export async function uninstallHookCommand(options: { target?: string } = {}): Promise<void> {
  const { target = 'claude' } = options;

  if (target === 'vibe') {
    return uninstallVibeHookCommand();
  } else if (target === 'opencode') {
    return uninstallOpenCodeHookCommand();
  }

  return uninstallClaudeHookCommand();
}

async function uninstallOpenCodeHookCommand(): Promise<void> {
  console.log(chalk.cyan('\nUninstall Code Insights Hook (OpenCode)\n'));

  const pluginPath = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'code-insights.ts');

  if (!fs.existsSync(pluginPath)) {
    console.log(chalk.yellow('No Code Insights plugin found. Nothing to uninstall.'));
    return;
  }

  try {
    fs.rmSync(pluginPath);
    console.log(chalk.green('Hook uninstalled successfully!'));
  } catch (error) {
    console.log(chalk.red(`Failed to uninstall hook: ${error instanceof Error ? error.message : 'Unknown error'}`));
  }
}

async function uninstallClaudeHookCommand(): Promise<void> {
  console.log(chalk.cyan('\nUninstall Code Insights Hooks (Claude Code)\n'));

  if (!fs.existsSync(CLAUDE_HOOKS_FILE)) {
    console.log(chalk.yellow('No hooks file found. Nothing to uninstall.'));
    return;
  }

  try {
    const content = fs.readFileSync(CLAUDE_HOOKS_FILE, 'utf-8');
    const settings: ClaudeSettings = JSON.parse(content);

    if (!settings.hooks?.Stop && !settings.hooks?.SessionEnd) {
      console.log(chalk.yellow('No Code Insights hooks found. Nothing to uninstall.'));
      return;
    }

    // Filter out Code Insights Stop hooks
    if (settings.hooks.Stop) {
      settings.hooks.Stop = settings.hooks.Stop.filter(
        (h) => !h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
      );
      if (settings.hooks.Stop.length === 0) {
        delete settings.hooks.Stop;
      }
    }

    // Filter out Code Insights SessionEnd hooks
    if (settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (h) => !h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
      );
      if (settings.hooks.SessionEnd.length === 0) {
        delete settings.hooks.SessionEnd;
      }
    }

    // Clean up empty hooks object
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(CLAUDE_HOOKS_FILE, JSON.stringify(settings, null, 2));

    console.log(chalk.green('Hooks uninstalled successfully!'));
  } catch (error) {
    console.log(chalk.red('Failed to uninstall hooks:'));
    console.error(error instanceof Error ? error.message : 'Unknown error');
  }
}

async function uninstallVibeHookCommand(): Promise<void> {
  console.log(chalk.cyan('\nUninstall Code Insights Hook (Mistral Vibe)\n'));

  if (!fs.existsSync(VIBE_HOOKS_FILE)) {
    console.log(chalk.yellow('No hooks file found. Nothing to uninstall.'));
    return;
  }

  try {
    const content = fs.readFileSync(VIBE_HOOKS_FILE, 'utf-8');
    
    // Very basic string parsing to remove the code-insights hook since we lack a TOML parser.
    // It looks for [[hooks]] ... name = "code-insights-session-end" ... up to the next [[hooks]] or EOF.
    let updatedContent = content;
    const codeInsightsHookRegex = /\[\[hooks\]\][\s\S]*?name\s*=\s*"code-insights-session-end"[\s\S]*?(?=\[\[hooks\]\]|$)/g;
    
    if (!codeInsightsHookRegex.test(content)) {
      console.log(chalk.yellow('No Code Insights hooks found. Nothing to uninstall.'));
      return;
    }

    updatedContent = updatedContent.replace(codeInsightsHookRegex, '');
    
    // Remove extra blank lines that might have been left behind
    updatedContent = updatedContent.replace(/\n\s*\n\s*\n/g, '\n\n');

    fs.writeFileSync(VIBE_HOOKS_FILE, updatedContent.trim() + '\n');

    console.log(chalk.green('Hook uninstalled successfully!'));
  } catch (error) {
    console.log(chalk.red('Failed to uninstall hook:'));
    console.error(error instanceof Error ? error.message : 'Unknown error');
  }
}
