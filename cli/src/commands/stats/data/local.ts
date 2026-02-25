// ──────────────────────────────────────────────────────
// Local data source for stats commands
//
// Reads from the disk-based stats cache (no Firestore).
// Zero-config: works out of the box by discovering and
// parsing local session files from all providers.
// ──────────────────────────────────────────────────────

import type {
  StatsDataSource,
  SessionRow,
  SessionQueryOptions,
  UsageStatsDoc,
  ProjectResolution,
  PrepareResult,
  StatsFlags,
} from './types.js';
import { ProjectNotFoundError } from './types.js';
import { StatsCache } from './cache.js';

// ──────────────────────────────────────────────────────
// Helpers (duplicated from firestore.ts to avoid
// importing firebase-dependent code)
// ──────────────────────────────────────────────────────

/** Standard Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/** Returns candidate names within maxDistance, sorted by distance */
function findSimilarNames(input: string, candidates: string[], maxDistance = 3): string[] {
  const lower = input.toLowerCase();
  return candidates
    .map((name) => ({ name, distance: levenshtein(lower, name.toLowerCase()) }))
    .filter(({ distance }) => distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map(({ name }) => name);
}

// ──────────────────────────────────────────────────────
// LocalDataSource
// ──────────────────────────────────────────────────────

export class LocalDataSource implements StatsDataSource {
  readonly name = 'local';
  private cache: StatsCache;

  constructor() {
    this.cache = new StatsCache();
  }

  async prepare(flags: StatsFlags): Promise<PrepareResult> {
    if (flags.noSync) {
      const total = this.cache.getAllRows().length;
      return { message: `${total} sessions cached`, dataChanged: false };
    }

    const result = await this.cache.refresh();
    if (result.newSessions > 0) {
      return {
        message: `Parsed ${result.newSessions} new sessions (${result.totalSessions} total)`,
        dataChanged: true,
      };
    }
    return { message: `${result.totalSessions} sessions cached`, dataChanged: false };
  }

  async getSessions(opts: SessionQueryOptions): Promise<SessionRow[]> {
    let rows = this.cache.getAllRows();

    if (opts.periodStart) rows = rows.filter((r) => r.startedAt >= opts.periodStart!);
    if (opts.projectId) rows = rows.filter((r) => r.projectId === opts.projectId);
    if (opts.sourceTool) rows = rows.filter((r) => r.sourceTool === opts.sourceTool);

    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return rows;
  }

  async getUsageStats(): Promise<UsageStatsDoc | null> {
    // Local source has no pre-computed aggregate
    return null;
  }

  async resolveProjectId(name: string): Promise<ProjectResolution> {
    const rows = this.cache.getAllRows();
    const projects = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      if (!projects.has(row.projectId)) {
        projects.set(row.projectId, { id: row.projectId, name: row.projectName });
      }
    }
    const projectList = [...projects.values()];

    // Exact match (case-insensitive)
    const exact = projectList.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exact) return { projectId: exact.id, projectName: exact.name };

    // Substring match
    const substring = projectList.filter((p) => p.name.toLowerCase().includes(name.toLowerCase()));
    if (substring.length === 1) return { projectId: substring[0].id, projectName: substring[0].name };

    // No match — throw with suggestions
    const suggestions = findSimilarNames(name, projectList.map((p) => p.name));
    throw new ProjectNotFoundError(
      `Project "${name}" not found.`,
      name,
      projectList.map((p) => ({ name: p.name })),
      suggestions,
    );
  }

  async getLastSession(): Promise<SessionRow | null> {
    const rows = this.cache.getAllRows();
    if (rows.length === 0) return null;
    return rows.reduce((latest, row) => (row.startedAt > latest.startedAt ? row : latest));
  }
}
