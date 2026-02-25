import type { StatsDataSource, StatsFlags } from './types.js';
import { loadConfig } from '../../../utils/config.js';
import { ConfigNotFoundError } from './types.js';

/**
 * Resolve which data source to use based on flags and config.
 *
 * Priority (highest to lowest):
 * 1. --local flag           -> always LocalDataSource
 * 2. --remote flag          -> always FirestoreDataSource (error if not configured)
 * 3. config.dataSource      -> as configured ('local' or 'firebase')
 * 4. No config, Firebase creds present -> FirestoreDataSource (backward compat)
 * 5. No config at all       -> LocalDataSource (zero-config first run)
 */
export async function resolveDataSource(flags: StatsFlags): Promise<StatsDataSource> {
  if (flags.local) {
    const { LocalDataSource } = await import('./local.js');
    return new LocalDataSource();
  }

  if (flags.remote) {
    const config = loadConfig();
    if (!config?.firebase) {
      throw new ConfigNotFoundError(
        'Firebase not configured. Run `code-insights init` first, or use `stats --local` for local-only stats.'
      );
    }
    const { FirestoreDataSource } = await import('./firestore.js');
    return new FirestoreDataSource(config);
  }

  const config = loadConfig();

  if (!config) {
    const { LocalDataSource } = await import('./local.js');
    return new LocalDataSource();
  }

  // Explicit dataSource preference or backward-compat inference
  const useFirebase =
    (config as Record<string, unknown>).dataSource === 'firebase' ||
    (!(config as Record<string, unknown>).dataSource && config.firebase?.projectId);

  if (useFirebase && config.firebase) {
    const { FirestoreDataSource } = await import('./firestore.js');
    return new FirestoreDataSource(config);
  }

  const { LocalDataSource } = await import('./local.js');
  return new LocalDataSource();
}
