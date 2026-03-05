// Friction category normalization using Levenshtein distance.
// Clusters similar free-form friction categories to canonical ones during aggregation.

import { CANONICAL_FRICTION_CATEGORIES } from './prompts.js';

/** Standard Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

/**
 * Normalize a friction category to the closest canonical category.
 * Returns the original category if no close match is found.
 *
 * Matching rules (in order):
 * 1. Exact match against canonical list → return as-is
 * 2. Levenshtein distance <= 2 → return canonical match
 * 3. Substring match (category contains canonical or vice versa) → return canonical
 * 4. No match → return original (novel category)
 */
export function normalizeFrictionCategory(category: string): string {
  const lower = category.toLowerCase();

  // 1. Exact match
  for (const canonical of CANONICAL_FRICTION_CATEGORIES) {
    if (lower === canonical) return canonical;
  }

  // 2. Levenshtein distance <= 2
  let bestMatch: string | null = null;
  let bestDistance = Infinity;
  for (const canonical of CANONICAL_FRICTION_CATEGORIES) {
    const dist = levenshtein(lower, canonical);
    if (dist <= 2 && dist < bestDistance) {
      bestDistance = dist;
      bestMatch = canonical;
    }
  }
  if (bestMatch) return bestMatch;

  // 3. Substring match
  for (const canonical of CANONICAL_FRICTION_CATEGORIES) {
    if (lower.includes(canonical) || canonical.includes(lower)) {
      return canonical;
    }
  }

  // 4. No match — novel category
  return category;
}

/**
 * Normalize and group friction points by canonical category.
 * Used during aggregation to cluster similar categories together.
 */
export function normalizeAndGroupFriction<T extends { category: string }>(
  items: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const normalized = normalizeFrictionCategory(item.category);
    const group = groups.get(normalized) || [];
    group.push({ ...item, category: normalized });
    groups.set(normalized, group);
  }

  return groups;
}
