/**
 * DB-backed ActivePromptLookup (carry-forward 5): reads active_prompt_versions joined to
 * prompt_versions. Lives here, not in the engine, so the plain CLI/server analysis path can
 * resolve promoted prompts without loading the optimizer.
 *
 * The lookup never throws: a missing DB, a pre-v20 database, or a corrupt components_json all
 * degrade to "no active version" (built-in prompt) so analysis keeps working.
 */

import type Database from 'better-sqlite3';
import { getActivePromptVersion } from '../db/optimization.js';
import type { ActivePromptLookup } from './resolve-prompt.js';

export function createDbPromptLookup(getDatabase: () => Database.Database | null): ActivePromptLookup {
  return (target, key) => {
    try {
      const db = getDatabase();
      if (!db) return null;
      const version = getActivePromptVersion(db, target, key);
      if (!version) return null;
      return { versionId: version.id, identityKey: version.identityKey, components: version.components };
    } catch {
      return null;
    }
  };
}
