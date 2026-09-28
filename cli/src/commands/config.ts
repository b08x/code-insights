import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, saveConfig, isConfigured } from '../utils/config.js';
import { trackEvent } from '../utils/telemetry.js';
import { PROVIDERS, getDefaultModel } from '../constants/llm-providers.js';
import { getEffectivePlans, DEFAULT_PLANS } from '../utils/plans.js';
import type { ClaudeInsightConfig, LLMProviderConfig, LLMProvider } from '../types.js';

// Map provider -> env var name for display
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  gemini:     'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral:    'MISTRAL_API_KEY',
};

/**
 * Describe how the API key is being sourced for display purposes.
 */
function describeApiKeySource(provider: LLMProvider, hasStoredKey: boolean): string {
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && process.env[envVar]) {
    return '(from env var ' + envVar + ')';
  }
  if (hasStoredKey) {
    return '(session only — not persisted to disk)';
  }
  return '(not set — set ' + (envVar ?? 'the API key') + ' env var)';
}

/**
 * Show current configuration summary.
 */
function showConfigAction(): void {
  if (!isConfigured()) {
    console.log(chalk.yellow('\nNot configured. Run `code-insights init` to set up.\n'));
    return;
  }

  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\nFailed to load config.\n'));
    return;
  }

  console.log(chalk.cyan('\n  Code Insights Configuration\n'));

  // Sync
  console.log(chalk.white('  Sync:'));
  console.log(chalk.gray(`    Claude dir: ${config.sync.claudeDir}`));
  if (config.sync.excludeProjects.length > 0) {
    console.log(chalk.gray(`    Excluded:   ${config.sync.excludeProjects.join(', ')}`));
  }

  // Dashboard (Phase 3)
  if (config.dashboard?.port) {
    console.log(chalk.white('\n  Dashboard:'));
    console.log(chalk.gray(`    Port: ${config.dashboard.port}`));
  }

  // LLM config
  if (config.dashboard?.llm) {
    const llm = config.dashboard.llm;

    console.log(chalk.white('\n  LLM:'));
    console.log(chalk.gray(`    Provider: ${llm.provider}`));
    console.log(chalk.gray(`    Model:    ${llm.model}`));
    if (llm.provider !== 'ollama') {
      console.log(chalk.gray(`    API Key:  ${describeApiKeySource(llm.provider, !!llm.apiKey)}`));
    }
    if (llm.baseUrl) {
      console.log(chalk.gray(`    Base URL: ${llm.baseUrl}`));
    }
  }

  // Retrieval config (RAG for insight generation)
  if (config.dashboard?.analysis?.retrieval) {
    const r = config.dashboard.analysis.retrieval;
    console.log(chalk.white('\n  Retrieval (insight RAG):'));
    console.log(chalk.gray(`    Enabled:    ${r.enabled !== false ? 'yes' : 'no'}`));
    console.log(chalk.gray(`    Top-K:      ${r.topK ?? 5}`));
    console.log(chalk.gray(`    Threshold:  ${r.similarityThreshold ?? 0.75}`));
    console.log(chalk.gray(`    Same-proj:  ${r.sameProjectOnly !== false ? 'yes' : 'no'}`));
  }

  // Pricing Plans (Subscriptions & Pay-As-You-Go)
  const plans = getEffectivePlans(config);
  console.log(chalk.white('\n  Pricing Plans:'));
  for (const p of Object.values(plans)) {
    const feeStr = p.type === 'subscription'
      ? chalk.green(`$${(p.monthlyFee ?? 0).toFixed(2)}/mo`)
      : p.type === 'free'
      ? chalk.gray('free')
      : chalk.yellow('pay-as-you-go');
    console.log(chalk.gray(`    ${p.name.padEnd(42)} ${feeStr.padEnd(20)} [${p.tools.join(', ')}]`));
  }

  // Telemetry — default is enabled; env vars can override at runtime
  console.log(chalk.white('\n  Telemetry:'));
  const telemetryEnabled = config.telemetry !== false;
  if (process.env.CODE_INSIGHTS_TELEMETRY_DISABLED === '1' || process.env.DO_NOT_TRACK === '1') {
    console.log(chalk.yellow('    Status:  disabled (via env var)'));
  } else {
    console.log(chalk.gray(`    Status:  ${telemetryEnabled ? 'enabled' : 'disabled'}`));
  }

  console.log('');
  trackEvent('cli_config', { subcommand: 'view', success: true });
}

export const configCommand = new Command('config')
  .description('Show Code Insights configuration')
  .action(() => {
    showConfigAction();
  });

configCommand
  .command('set <key> <value>')
  .description('Set a configuration value (telemetry)')
  .action((key: string, value: string) => {
    if (key === 'telemetry') {
      if (value !== 'true' && value !== 'false') {
        console.error(chalk.red(`\nInvalid value "${value}". Must be "true" or "false".\n`));
        process.exit(1);
      }
      const existing = loadConfig();
      if (!existing) {
        saveConfig({
          sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
          telemetry: value === 'true',
        });
      } else {
        existing.telemetry = value === 'true';
        saveConfig(existing);
      }
      console.log(chalk.green(`\nTelemetry ${value === 'true' ? 'enabled' : 'disabled'}.\n`));
      trackEvent('cli_config', { subcommand: 'set', success: true });
    } else {
      console.error(chalk.red(`\nUnknown config key "${key}". Available: telemetry.\n`));
      process.exit(1);
    }
  });

// ── config plans ──────────────────────────────────────────────────────────────

configCommand
  .command('plans')
  .description('View or configure pricing plans (subscriptions vs pay-as-you-go)')
  .option('--set <setting>', 'Set a plan property (e.g. --set claude.monthlyFee=21.00 or --set gemini.monthlyFee=19.99)')
  .option('--reset', 'Reset all plans to defaults')
  .action((options: { set?: string; reset?: boolean }) => {
    const existing = loadConfig() ?? {
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
    };
    if (options.reset) {
      delete existing.plans;
      saveConfig(existing);
      console.log(chalk.green('\nPricing plans reset to defaults.\n'));
      return;
    }
    if (options.set) {
      const match = options.set.match(/^([^.]+)\.([^=]+)=(.+)$/);
      if (!match) {
        console.error(chalk.red('\nInvalid format. Expected: <planId>.<property>=<value> (e.g. claude.monthlyFee=21.00)\n'));
        process.exit(1);
      }
      const [, planId, prop, val] = match;
      if (!existing.plans) {
        existing.plans = { ...getEffectivePlans(existing) };
      }
      if (!existing.plans[planId]) {
        const defPlan = DEFAULT_PLANS[planId];
        if (defPlan) {
          existing.plans[planId] = { ...defPlan };
        } else {
          existing.plans[planId] = {
            id: planId,
            name: planId,
            type: 'subscription',
            tools: [planId],
          };
        }
      }
      if (prop === 'monthlyFee') {
        existing.plans[planId].monthlyFee = parseFloat(val);
      } else if (prop === 'type') {
        existing.plans[planId].type = val as any;
      } else if (prop === 'name') {
        existing.plans[planId].name = val;
      }
      saveConfig(existing);
      console.log(chalk.green(`\nUpdated ${planId}.${prop} = ${val}\n`));
      return;
    }

    const plans = getEffectivePlans(existing);
    console.log(chalk.cyan('\n  Active Pricing Plans\n'));
    for (const p of Object.values(plans)) {
      const typeBadge = p.type === 'subscription'
        ? chalk.green(`[Subscription: $${(p.monthlyFee ?? 0).toFixed(2)}/mo]`)
        : p.type === 'free'
        ? chalk.gray('[Free / Local]')
        : chalk.yellow('[Pay-As-You-Go]');
      console.log(`  ${chalk.bold(p.name)} ${typeBadge}`);
      console.log(chalk.gray(`    Plan ID: ${p.id} | Tools: ${p.tools.join(', ')}`));
    }
    console.log(chalk.dim('\n  To update a monthly fee: code-insights config plans --set <planId>.monthlyFee=<amount>\n'));
  });

// ── config llm ────────────────────────────────────────────────────────────────

const llmCommand = configCommand
  .command('llm')
  .description('Configure LLM provider for AI-powered session analysis')
  .option('--provider <provider>', 'LLM provider (openai, anthropic, gemini, ollama)')
  .option('--model <model>', 'Model ID (e.g., gpt-4o, claude-sonnet-4-20250514)')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('--base-url <url>', 'Custom base URL (for Ollama or local endpoints)')
  .option('--show', 'Show current LLM configuration')
  .action(async (options: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    show?: boolean;
  }) => {
    // --show: display current LLM config and exit
    if (options.show) {
      const config = loadConfig();
      const llm = config?.dashboard?.llm;

      if (!llm) {
        console.log(chalk.yellow('\nLLM not configured. Run `code-insights config llm` to set up.\n'));
        return;
      }

      console.log(chalk.cyan('\n  LLM Configuration\n'));
      console.log(chalk.gray(`    Provider: ${llm.provider}`));
      console.log(chalk.gray(`    Model:    ${llm.model}`));
      if (llm.provider !== 'ollama') {
        console.log(chalk.gray(`    API Key:  ${describeApiKeySource(llm.provider, !!llm.apiKey)}`));
      }
      if (llm.baseUrl) {
        console.log(chalk.gray(`    Base URL: ${llm.baseUrl}`));
      }
      console.log('');
      return;
    }

    // Non-interactive: all required fields provided via flags
    if (options.provider && options.model) {
      const validProviders = PROVIDERS.map(p => p.id);
      if (!validProviders.includes(options.provider as LLMProviderConfig['provider'])) {
        console.error(chalk.red(`\nInvalid provider "${options.provider}". Must be one of: ${validProviders.join(', ')}\n`));
        process.exit(1);
      }

      const providerInfo = PROVIDERS.find(p => p.id === options.provider);
      if (providerInfo?.requiresApiKey && !options.apiKey) {
        console.error(chalk.red(`\nProvider "${options.provider}" requires an API key. Use --api-key <key>\n`));
        process.exit(1);
      }

      const llmConfig: LLMProviderConfig = {
        provider: options.provider as LLMProviderConfig['provider'],
        model: options.model,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      };

      saveLLMConfig(llmConfig);
      console.log(chalk.green(`\nLLM configured: ${options.provider} / ${options.model}\n`));
      return;
    }

    // Interactive flow
    await runInteractiveLLMConfig();
  });

/**
 * Interactive LLM configuration wizard.
 */
async function runInteractiveLLMConfig(): Promise<void> {
  const existing = loadConfig()?.dashboard?.llm;

  console.log(chalk.cyan('\n  LLM Configuration\n'));
  console.log(chalk.gray('  Configure the AI provider used for session analysis.\n'));

  // Step 1: Select provider
  const { provider } = await inquirer.prompt<{ provider: LLMProviderConfig['provider'] }>([
    {
      type: 'list',
      name: 'provider',
      message: 'Select LLM provider:',
      choices: PROVIDERS.map(p => ({
        name: `${p.name}${p.requiresApiKey ? '' : ' (no API key needed)'}`,
        value: p.id,
      })),
      default: existing?.provider ?? 'ollama',
    },
  ]);

  const providerInfo = PROVIDERS.find(p => p.id === provider);
  if (!providerInfo) {
    console.error(chalk.red('\nFailed to find provider info. Aborting.\n'));
    process.exit(1);
  }

  // Step 2: Select model
  const { model } = await inquirer.prompt<{ model: string }>([
    {
      type: 'list',
      name: 'model',
      message: 'Select model:',
      choices: providerInfo.models.map(m => ({
        name: `${m.name}${m.description ? ` — ${m.description}` : ''}`,
        value: m.id,
      })),
      default: existing?.model ?? getDefaultModel(provider),
    },
  ]);

  const llmConfig: LLMProviderConfig = { provider, model };

  // Step 3: API key (if required)
  if (providerInfo.requiresApiKey) {
    const envVar = PROVIDER_API_KEY_ENV[provider];
    const hasEnvKey = envVar ? !!process.env[envVar] : false;
    const hasStoredKey = !!existing?.apiKey;

    let message = `API key for ${providerInfo.name}`;
    if (hasEnvKey) {
      message += ` (${envVar} is set — will be used instead)`;
    } else if (hasStoredKey) {
      message += ' (stored session-only, press Enter to keep)';
    } else if (envVar) {
      message += ` (or set ${envVar} env var)`;
    }
    message += ':';

    const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
      {
        type: 'password',
        name: 'apiKey',
        message,
        mask: '*',
        validate: (val: string) => {
          if (!val && !hasEnvKey && !hasStoredKey) {
            return `API key required for ${providerInfo.name} — set ${envVar ?? 'the API key'} env var to avoid prompts`;
          }
          return true;
        },
      },
    ]);

    // Only store in session (llmConfig.apiKey) — saveConfig strips it before writing to disk.
    // The stored key persists in memory for this session only.
    if (apiKey) {
      llmConfig.apiKey = apiKey;
    }
    // Note: we no longer auto-preserve existing?.apiKey since the session may have
    // started with a key from env var, and explicit blank means "don't use a stored key".
  }

  // Step 4: Base URL (Ollama or custom)
  if (provider === 'ollama') {
    const { baseUrl } = await inquirer.prompt<{ baseUrl: string }>([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Ollama URL (leave blank for default http://localhost:11434):',
        default: existing?.baseUrl ?? '',
      },
    ]);

    if (baseUrl && baseUrl !== 'http://localhost:11434') {
      llmConfig.baseUrl = baseUrl;
    }
  }

  saveLLMConfig(llmConfig);

  console.log(chalk.green(`\nLLM configured: ${providerInfo.name} / ${model}\n`));
  if (providerInfo.requiresApiKey) {
    const envVar = PROVIDER_API_KEY_ENV[provider];
    if (envVar && process.env[envVar]) {
      console.log(chalk.dim(`  Using API key from ${envVar}\n`));
    } else if (llmConfig.apiKey) {
      console.log(chalk.dim('  API key stored for this session only — not written to disk.\n'));
      console.log(chalk.dim(`  For persistent use, set the ${envVar} environment variable.\n`));
    } else {
      console.log(chalk.dim(`  Get an API key: ${providerInfo.apiKeyLink}\n`));
    }
  }
}

/**
 * Save LLM config into the dashboard.llm field of the CLI config file.
 */
function saveLLMConfig(llmConfig: LLMProviderConfig): void {
  const existing: ClaudeInsightConfig = loadConfig() ?? {
    sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
  };
  existing.dashboard = { ...existing.dashboard, llm: llmConfig };
  saveConfig(existing);
}

// Suppress unused variable warning — llmCommand is registered via .command() side-effect
void llmCommand;
