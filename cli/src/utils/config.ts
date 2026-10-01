import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ClaudeInsightConfig, OptimizationConfig, OptimizationModelRef, SyncState } from '../types.js';
import { DEFAULT_WEIGHTS } from '../optimization/metric.js';

const CONFIG_DIR = path.join(os.homedir(), '.code-insights');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SYNC_STATE_FILE = path.join(CONFIG_DIR, 'sync-state.json');

/**
 * Ensure config directory exists
 */
export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load configuration from file
 */
export function loadConfig(): ClaudeInsightConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as ClaudeInsightConfig;
  } catch {
    return null;
  }
}

/**
 * Save configuration to file.
 *
 * Only the known fields of ClaudeInsightConfig are written. This strips any
 * stale keys (e.g. `firebase`, `webConfig`, `dataSource`, `dashboardUrl`)
 * that may have been persisted by earlier versions of the CLI, so they don't
 * accumulate in the config file across upgrades.
 */
export function saveConfig(config: ClaudeInsightConfig): void {
  ensureConfigDir();
  const clean: ClaudeInsightConfig = {
    sync: config.sync,
  };
  if (config.dashboard !== undefined) {
    clean.dashboard = {
      ...(config.dashboard.port !== undefined ? { port: config.dashboard.port } : {}),
    };
    // Strip apiKey from LLM config — keys are resolved from environment variables
    // at runtime and are never persisted to disk.
    if (config.dashboard.llm !== undefined) {
      const { apiKey: _omitted, ...llmWithoutKey } = config.dashboard.llm;
      clean.dashboard.llm = llmWithoutKey;
    }
    if (config.dashboard.agent !== undefined) {
      // Spread preserves non-secret agent keys such as `codebaseTools`.
      const { apiKey: _omitted, ...agentWithoutKey } = config.dashboard.agent;
      clean.dashboard.agent = agentWithoutKey;
    }
    if (config.dashboard.embedding !== undefined) {
      const { apiKey: _omitted, ...embeddingWithoutKey } = config.dashboard.embedding;
      clean.dashboard.embedding = embeddingWithoutKey;
    }
    // Preserve dashboard.analysis sub-object (runner selection, retrieval config, etc.)
    if (config.dashboard?.analysis) {
      const { runner, ...restAnalysis } = config.dashboard.analysis;
      clean.dashboard.analysis = {
        ...restAnalysis,
        ...(runner?.name ? { runner: { ...runner } } : {}),
      };
    }
  }
  if (config.optimization !== undefined) {
    // Nested copies so a caller mutating its config later cannot change what was just saved.
    const { teacher, judge, weights, caps } = config.optimization;
    clean.optimization = {
      ...(teacher ? { teacher: { ...teacher } } : {}),
      ...(judge ? { judge: { ...judge } } : {}),
      ...(weights ? { weights: { ...weights } } : {}),
      ...(caps ? { caps: { ...caps } } : {}),
    };
  }
  if (config.plans !== undefined) {
    clean.plans = config.plans;
  }
  if (config.telemetry !== undefined) {
    clean.telemetry = config.telemetry;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

/** Optimization settings with defaults applied; `teacher`/`judge` stay undefined until chosen in Settings. */
export interface ResolvedOptimizationConfig {
  teacher: OptimizationModelRef | null;
  judge: OptimizationModelRef | null;
  weights: Record<string, number>;
  caps: { maxMetricCalls: number; maxTokens?: number; maxCostUsd?: number };
}

/** GEPA budget when neither the run request nor config sets one (about a light run). */
export const DEFAULT_MAX_METRIC_CALLS = 120;

const isModelRef = (v: unknown): v is OptimizationModelRef =>
  !!v && typeof v === 'object'
  && typeof (v as OptimizationModelRef).provider === 'string'
  && typeof (v as OptimizationModelRef).model === 'string'
  && (v as OptimizationModelRef).model !== '';

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * config.json is hand-editable: malformed pieces fall back to the default instead of failing a
 * run. Weights keep only finite non-negative numbers; if none survive the defaults are used.
 */
export function resolveOptimizationConfig(config: ClaudeInsightConfig | null | undefined): ResolvedOptimizationConfig {
  const raw: OptimizationConfig = config?.optimization ?? {};
  const weights = Object.fromEntries(
    Object.entries(raw.weights ?? {}).filter(([, w]) => typeof w === 'number' && Number.isFinite(w) && w >= 0),
  );
  const maxTokens = positive(raw.caps?.maxTokens);
  const maxCostUsd = positive(raw.caps?.maxCostUsd);
  return {
    teacher: isModelRef(raw.teacher) ? { ...raw.teacher } : null,
    judge: isModelRef(raw.judge) ? { ...raw.judge } : null,
    weights: Object.values(weights).some(w => w > 0) ? weights : { ...DEFAULT_WEIGHTS },
    caps: {
      maxMetricCalls: Math.floor(positive(raw.caps?.maxMetricCalls) ?? DEFAULT_MAX_METRIC_CALLS),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
  };
}

/**
 * Load sync state
 */
export function loadSyncState(): SyncState {
  try {
    if (!fs.existsSync(SYNC_STATE_FILE)) {
      return { lastSync: '', files: {} };
    }
    const content = fs.readFileSync(SYNC_STATE_FILE, 'utf-8');
    return JSON.parse(content) as SyncState;
  } catch {
    return { lastSync: '', files: {} };
  }
}

/**
 * Save sync state
 */
export function saveSyncState(state: SyncState): void {
  ensureConfigDir();
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Get default Claude directory
 */
export function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Get Gemini CLI home directory
 */
export function getGeminiHomeDir(): string {
  return path.join(os.homedir(), '.gemini');
}

/**
 * Get Gemini CLI temporary directory (where sessions are stored)
 */
export function getGeminiTmpDir(): string {
  return path.join(getGeminiHomeDir(), 'tmp');
}

/**
 * Get Hermes Agent home directory
 */
export function getHermesHomeDir(): string {
  return path.join(os.homedir(), '.hermes');
}

/**
 * Get OpenCode storage directory
 */
export function getOpenCodeDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, '.local', 'share', 'opencode'); // Default fallback for Windows if not in AppData
  }
  return path.join(home, '.local', 'share', 'opencode');
}

/**
 * Get Mistral Vibe home directory
 */
export function getVibeHomeDir(): string {
  return process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
}

/**
 * Get Mistral Vibe logs directory
 */
export function getVibeLogsDir(): string {
  return path.join(getVibeHomeDir(), 'logs', 'session');
}

/**
 * Check if config exists
 */
export function isConfigured(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get the sync state file path (used by reset command)
 */
export function getSyncStatePath(): string {
  return SYNC_STATE_FILE;
}

/**
 * Get Claude Desktop local agent mode directory
 */
export function getClaudeDesktopDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'local-agent-mode-sessions');
}
