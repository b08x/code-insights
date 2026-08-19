// Recurring insight detection — finds semantically similar insights using
// sqlite-vec KNN similarity search, then uses LLM only for theme naming.
//
// Architecture:
//   1. Load insight embeddings from the sqlite-vec virtual table (vec_insights)
//   2. For each ungrouped insight, query its K nearest neighbors
//   3. Filter neighbors by cosine similarity >= SIMILARITY_THRESHOLD (0.85)
//   4. Apply MMR (Maximal Marginal Relevance) to avoid redundant groups
//   5. Use LLM ONLY to name each group's theme (cheap — small prompt)
//
// This replaces the previous approach of sending all 200 insights to the LLM
// for clustering, which was slow (~30s) and expensive (~90% more tokens).

import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getDb } from '@code-insights/cli/db/client';
import { createLLMClient, isLLMConfigured } from './client.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Cosine similarity threshold for grouping. AutoRefine uses 0.85 for merges. */
const SIMILARITY_THRESHOLD = 0.85;

/**
 * Maximum number of nearest neighbors to fetch per insight from sqlite-vec.
 * Larger values catch more potential group members but increase query time.
 * For 15K insights with dim=1024, K=50 is a reasonable default.
 */
const KNN_TOP_K = 50;

/**
 * MMR lambda: trade-off between relevance (to the group seed) and diversity
 * (away from already-selected group members).
 *   1.0 = pure relevance, 0.0 = pure diversity
 * 0.7 preserves thematic coherence while avoiding near-duplicate groups.
 */
const MMR_LAMBDA = 0.7;

/** Maximum insights fetched from the vector table in one pass. */
const MAX_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightEmbedding {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  type: string;
  /** The embedding vector (dim=768 for embeddinggemma). */
  vector: Float32Array;
}

export interface RecurringInsightGroup {
  insightIds: string[];
  theme: string;
}

export interface RecurringInsightResult {
  success: boolean;
  groups: RecurringInsightGroup[];
  updatedCount: number;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

/** Dot product of two vectors. */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** L2 norm (magnitude) of a vector. */
function l2Norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/** Cosine similarity between two vectors. Returns [-1, 1]. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const denom = l2Norm(a) * l2Norm(b);
  if (denom === 0) return 0;
  return dotProduct(a, b) / denom;
}

/**
 * Convert sqlite-vec L2 distance to cosine similarity.
 * Only valid when vectors are unit-normalized (||v|| = 1).
 * Formula: cos_sim = 1 - (l2_dist^2 / 2)
 */
function l2ToCosineSimilarity(l2Distance: number): number {
  return 1 - (l2Distance * l2Distance) / 2;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load insight embeddings from the database.
 * Joins the insights table with the vec_insights virtual table.
 */
function loadInsightEmbeddings(db: Database.Database): InsightEmbedding[] {
  // Ensure the sqlite-vec extension is loaded
  sqliteVec.load(db);

  // Check if the vector table exists
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_insights'"
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    return [];
  }

  const rows = db.prepare(`
    SELECT
      i.id,
      i.session_id,
      i.title,
      i.summary,
      i.type,
      v.embedding
    FROM insights i
    INNER JOIN vec_insights v ON v.id = i.id
    WHERE i.type NOT IN ('summary', 'prompt_quality')
    LIMIT ?
  `).all(MAX_CANDIDATES) as Array<{
    id: string;
    session_id: string;
    title: string;
    summary: string;
    type: string;
    embedding: Buffer;
  }>;

  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    title: r.title,
    summary: r.summary,
    type: r.type,
    vector: new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      r.embedding.byteLength / 4,
    ),
  }));
}

// ---------------------------------------------------------------------------
// KNN clustering with MMR
// ---------------------------------------------------------------------------

/**
 * Find semantically similar groups using vector KNN.
 *
 * Algorithm:
 *   1. For each insight, query its K nearest neighbors via sqlite-vec
 *   2. Keep neighbors with cosine similarity >= threshold
 *   3. Greedily form groups: pick the ungrouped insight with the most
 *      similar neighbors as the seed, then grow the group using MMR
 *   4. Repeat until no more groups of size >= 2 can be formed
 */
function findGroupsByVectorSimilarity(
  embeddings: InsightEmbedding[],
  topK: number = KNN_TOP_K,
  threshold: number = SIMILARITY_THRESHOLD,
  mmrLambda: number = MMR_LAMBDA,
): string[][] {
  if (embeddings.length < 2) return [];

  const db = getDb();
  sqliteVec.load(db);

  const dim = embeddings[0].vector.length;

  // Pre-compute L2 norms for cosine similarity
  const norms = new Map<string, number>();
  for (const e of embeddings) {
    norms.set(e.id, l2Norm(e.vector));
  }

  // Build id -> index map for fast lookup
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < embeddings.length; i++) {
    idToIndex.set(embeddings[i].id, i);
  }

  // For each insight, find neighbors above the similarity threshold
  // using sqlite-vec KNN query, then re-rank by cosine similarity.
  const neighborMap = new Map<string, Array<{ id: string; similarity: number }>>();

  const knnStmt = db.prepare(
    `SELECT id, distance FROM vec_insights WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
  );

  for (const e of embeddings) {
    const blob = Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength);
    const knnResults = knnStmt.all(blob, topK + 1) as Array<{ id: string; distance: number }>;

    const neighbors: Array<{ id: string; similarity: number }> = [];
    const queryNorm = norms.get(e.id)!;

    for (const result of knnResults) {
      // Skip self
      if (result.id === e.id) continue;

      // Convert L2 distance to cosine similarity (assumes unit-normalized vectors)
      const cosSim = l2ToCosineSimilarity(result.distance);

      // Fast pre-filter using L2-derived similarity
      if (cosSim < threshold) continue;

      // Verify with exact cosine similarity (handles non-unit vectors gracefully)
      const neighborIdx = idToIndex.get(result.id);
      if (neighborIdx === undefined) continue; // not in our candidate set

      const exactCosSim = cosineSimilarity(e.vector, embeddings[neighborIdx].vector);
      if (exactCosSim >= threshold) {
        neighbors.push({ id: result.id, similarity: exactCosSim });
      }
    }

    if (neighbors.length > 0) {
      neighborMap.set(e.id, neighbors);
    }
  }

  // Greedy group formation with MMR deduplication
  const assigned = new Set<string>();
  const groups: string[][] = [];

  // Sort seeds by number of neighbors descending (most-connected first)
  const seeds = [...neighborMap.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  for (const [seedId, neighbors] of seeds) {
    if (assigned.has(seedId)) continue;

    // Filter out already-assigned neighbors
    const available = neighbors.filter(n => !assigned.has(n.id));
    if (available.length === 0) continue;

    // Start a new group with the seed
    const group: string[] = [seedId];
    assigned.add(seedId);

    // Grow the group using MMR: pick the next member that maximizes
    //   lambda * sim_to_seed - (1 - lambda) * max_sim_to_selected
    // This balances thematic relevance with diversity.
    const seedVec = embeddings[idToIndex.get(seedId)!].vector;

    while (available.some(n => !assigned.has(n.id))) {
      let bestId: string | null = null;
      let bestScore = -Infinity;

      for (const candidate of available) {
        if (assigned.has(candidate.id)) continue;

        const candIdx = idToIndex.get(candidate.id)!;
        const candVec = embeddings[candIdx].vector;

        // Relevance: similarity to the seed
        const relevance = cosineSimilarity(seedVec, candVec);

        // Diversity: max similarity to any already-selected member
        let maxSimToGroup = 0;
        for (const memberId of group) {
          const memberIdx = idToIndex.get(memberId)!;
          const sim = cosineSimilarity(candVec, embeddings[memberIdx].vector);
          if (sim > maxSimToGroup) maxSimToGroup = sim;
        }

        // MMR score
        const score = mmrLambda * relevance - (1 - mmrLambda) * maxSimToGroup;

        if (score > bestScore) {
          bestScore = score;
          bestId = candidate.id;
        }
      }

      if (bestId === null) break;

      // Only add if the candidate still meets the threshold with the seed
      const bestCosSim = cosineSimilarity(
        seedVec,
        embeddings[idToIndex.get(bestId)!].vector,
      );
      if (bestCosSim < threshold) break;

      group.push(bestId);
      assigned.add(bestId);
    }

    if (group.length >= 2) {
      groups.push(group);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// LLM theme naming
// ---------------------------------------------------------------------------

/**
 * Use LLM to generate a theme name for a group of insights.
 * This is the ONLY LLM call — much cheaper than full clustering.
 */
async function nameGroupTheme(
  groupInsights: Array<{ title: string; summary: string; type: string }>,
): Promise<string> {
  const client = createLLMClient();

  const insightList = groupInsights
    .map((i, idx) => `${idx + 1}. [${i.type}] ${i.title}\n   ${i.summary.slice(0, 120)}`)
    .join('\n');

  const prompt = `These ${groupInsights.length} insights were grouped together because they are semantically similar (cosine similarity >= 0.85).

${insightList}

Provide a single concise theme name (3-7 words) that captures the shared concept. Respond with the theme name only, no explanation.`;

  const response = await client.chat([
    {
      role: 'system',
      content: 'You are an expert at identifying themes in software development insights. Provide concise theme names.',
    },
    { role: 'user', content: prompt },
  ]);

  return response.content.trim().replace(/^["']|["']$/g, '');
}

// ---------------------------------------------------------------------------
// Old LLM-based clustering (kept for fallback / testing)
// ---------------------------------------------------------------------------

/**
 * Find recurring patterns using the old LLM-only approach.
 * Kept as findRecurringInsights if vector search is unavailable.
 */
export async function findRecurringInsightsByLLM(
  insights: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    project_name: string;
    session_id: string;
  }>,
): Promise<RecurringInsightResult> {
  if (!isLLMConfigured()) {
    return { success: false, groups: [], updatedCount: 0, error: 'LLM not configured.' };
  }

  const candidates = insights
    .filter(i => i.type !== 'summary' && i.type !== 'prompt_quality')
    .slice(0, MAX_CANDIDATES);

  if (candidates.length < 2) {
    return {
      success: false,
      groups: [],
      updatedCount: 0,
      error: 'Need at least 2 non-summary insights to find patterns.',
    };
  }

  try {
    const client = createLLMClient();

    const insightData = candidates.map(i => ({
      id: i.id,
      type: i.type === 'technique' ? 'learning' : i.type,
      title: i.title,
      summary: i.summary.slice(0, 150),
      projectName: i.project_name,
      sessionId: i.session_id,
    }));

    const prompt = `Analyze these insights from coding sessions and find groups of semantically similar or duplicate insights — ones that express the same learning or decision even if worded differently.

RULES:
- Only group insights that are genuinely about the same concept/topic
- Insights in a group should be from DIFFERENT sessions (same sessionId = not recurring)
- A group must have at least 2 insights
- An insight can only belong to one group
- Provide a brief "theme" describing what the group shares
- If no recurring patterns exist, return an empty groups array

INSIGHTS:
${JSON.stringify(insightData, null, 2)}

Respond with valid JSON only:
{
  "groups": [
    {
      "insightIds": ["insight_abc", "insight_def"],
      "theme": "Brief description of the shared concept"
    }
  ]
}`;

    const response = await client.chat([
      {
        role: 'system',
        content: 'You are an expert at identifying recurring patterns and themes across software development insights. You find semantically similar insights even when they are worded differently. Respond with valid JSON only.',
      },
      { role: 'user', content: prompt },
    ]);

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, groups: [], updatedCount: 0, error: 'Failed to parse recurring insights response.' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { groups: RecurringInsightGroup[] };
    const groups = parsed.groups || [];

    const validIds = new Set(candidates.map(i => i.id));
    const validGroups = groups
      .map(g => ({
        ...g,
        insightIds: g.insightIds.filter(id => validIds.has(id)),
      }))
      .filter(g => g.insightIds.length >= 2);

    if (validGroups.length === 0) {
      return {
        success: true,
        groups: [],
        updatedCount: 0,
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
          : undefined,
      };
    }

    return writeLinksAndReturn(candidates, validGroups, response.usage);
  } catch (error) {
    return {
      success: false,
      groups: [],
      updatedCount: 0,
      error: error instanceof Error ? error.message : 'Failed to find recurring insights',
    };
  }
}

// ---------------------------------------------------------------------------
// New vector-based approach
// ---------------------------------------------------------------------------

/**
 * Find recurring patterns using sqlite-vec KNN similarity search.
 * LLM is used ONLY for theme naming, not clustering.
 */
export async function findRecurringInsightsByVector(
  embeddings: InsightEmbedding[],
): Promise<RecurringInsightResult> {
  if (!isLLMConfigured()) {
    return { success: false, groups: [], updatedCount: 0, error: 'LLM not configured.' };
  }

  if (embeddings.length < 2) {
    return {
      success: false,
      groups: [],
      updatedCount: 0,
      error: 'Need at least 2 insight embeddings to find patterns.',
    };
  }

  try {
    // Step 1: Find groups using vector similarity + MMR
    const groupIds = findGroupsByVectorSimilarity(embeddings);

    if (groupIds.length === 0) {
      return { success: true, groups: [], updatedCount: 0 };
    }

    // Step 2: Build a lookup map for insight data
    const embeddingMap = new Map(embeddings.map(e => [e.id, e]));

    // Step 3: Use LLM to name each group's theme
    const groups: RecurringInsightGroup[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const ids of groupIds) {
      const groupInsights = ids
        .map(id => embeddingMap.get(id)!)
        .filter(Boolean)
        .map(e => ({ title: e.title, summary: e.summary, type: e.type }));

      if (groupInsights.length < 2) continue;

      const theme = await nameGroupTheme(groupInsights);
      groups.push({ insightIds: ids, theme });
    }

    if (groups.length === 0) {
      return { success: true, groups: [], updatedCount: 0 };
    }

    // Step 4: Write bidirectional links
    const db = getDb();
    const validIds = new Set(embeddings.map(e => e.id));

    const linkMap = new Map<string, string[]>();
    for (const group of groups) {
      for (const id of group.insightIds) {
        if (!validIds.has(id)) continue;
        const others = group.insightIds.filter(otherId => otherId !== id);
        const existing = linkMap.get(id) || [];
        linkMap.set(id, [...new Set([...existing, ...others])]);
      }
    }

    const updateLinks = db.prepare(
      `UPDATE insights SET linked_insight_ids = ? WHERE id = ?`
    );

    for (const [insightId, linkedIds] of linkMap.entries()) {
      updateLinks.run(JSON.stringify(linkedIds), insightId);
    }

    return {
      success: true,
      groups,
      updatedCount: linkMap.size,
      usage: (totalInputTokens + totalOutputTokens) > 0
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : undefined,
    };
  } catch (error) {
    return {
      success: false,
      groups: [],
      updatedCount: 0,
      error: error instanceof Error ? error.message : 'Failed to find recurring insights by vector',
    };
  }
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Find recurring insights — automatically selects vector-based approach
 * when embeddings are available, falls back to LLM-only otherwise.
 *
 * Overload 1: Pass InsightEmbedding[] for vector-based detection.
 * Overload 2: Pass plain insight objects for LLM-based detection.
 */
export async function findRecurringInsights(
  insights: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    project_name: string;
    session_id: string;
  }>,
): Promise<RecurringInsightResult>;
export async function findRecurringInsights(
  embeddings: InsightEmbedding[],
): Promise<RecurringInsightResult>;
export async function findRecurringInsights(
  input: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    project_name: string;
    session_id: string;
  }> | InsightEmbedding[],
): Promise<RecurringInsightResult> {
  // Detect which overload was called by checking for the `vector` property
  if (input.length > 0 && 'vector' in input[0]) {
    return findRecurringInsightsByVector(input as InsightEmbedding[]);
  }

  // Plain insights — try vector approach first by loading embeddings
  if (!isLLMConfigured()) {
    return { success: false, groups: [], updatedCount: 0, error: 'LLM not configured.' };
  }

  const db = getDb();
  try {
    sqliteVec.load(db);
    const embeddings = loadInsightEmbeddings(db);
    if (embeddings.length >= 2) {
      return findRecurringInsightsByVector(embeddings);
    }
  } catch {
    // sqlite-vec not available or vec_insights table missing — fall through
  }

  // Fallback: LLM-only clustering
  return findRecurringInsightsByLLM(input as Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    project_name: string;
    session_id: string;
  }>);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Write bidirectional links and return the result (used by LLM path). */
function writeLinksAndReturn(
  candidates: Array<{ id: string }>,
  validGroups: RecurringInsightGroup[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): RecurringInsightResult {
  const db = getDb();
  const validIds = new Set(candidates.map(i => i.id));

  const linkMap = new Map<string, string[]>();
  for (const group of validGroups) {
    for (const id of group.insightIds) {
      if (!validIds.has(id)) continue;
      const others = group.insightIds.filter(otherId => otherId !== id);
      const existing = linkMap.get(id) || [];
      linkMap.set(id, [...new Set([...existing, ...others])]);
    }
  }

  const updateLinks = db.prepare(
    `UPDATE insights SET linked_insight_ids = ? WHERE id = ?`
  );

  for (const [insightId, linkedIds] of linkMap.entries()) {
    updateLinks.run(JSON.stringify(linkedIds), insightId);
  }

  return {
    success: true,
    groups: validGroups,
    updatedCount: linkMap.size,
    usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined,
  };
}
