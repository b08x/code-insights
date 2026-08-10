import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { getDb } from '../db/client.js';
import { loadVectorExtension } from '../embeddings/store.js';
import { embedOne, DEFAULT_EMBEDDING_CONFIG } from '../embeddings/client.js';
import type { EmbeddingConfig } from '../embeddings/client.js';
import { trackEvent, captureError, classifyError } from '../utils/telemetry.js';
import type Database from 'better-sqlite3';

function buildEmbeddingConfig(overrides?: { model?: string; batchSize?: string }): EmbeddingConfig {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(overrides?.model ? { model: overrides.model } : {}),
    ...(overrides?.batchSize ? { batchSize: parseInt(overrides.batchSize, 10) } : {}),
  };
}

function getMessage(db: Database.Database, id: string) {
  return db.prepare(`
    SELECT m.id, m.content, m.type, m.timestamp, s.project_name
    FROM messages m
    LEFT JOIN sessions s ON m.session_id = s.id
    WHERE m.id = ?
  `).get(id) as { id: string; content: string; type: string; timestamp: string; project_name: string } | undefined;
}

function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

export async function searchCommand(query: string, opts: { topK?: string }): Promise<void> {
  if (!query) {
    console.error(chalk.red('Provide a search query: `code-insights search "query"`'));
    process.exit(1);
  }

  const topK = parseInt(opts.topK ?? '5', 10);
  console.log(chalk.cyan(`\n  Code Insights — Keyword Search (Messages)\n`));
  console.log(chalk.gray(`  Query: "${query}"`));
  console.log(chalk.gray(`  Top-K: ${topK}\n`));

  try {
    const db = getDb();
    const results = db.prepare(`
      SELECT rowid, bm25(messages_fts) as score
      FROM messages_fts
      WHERE messages_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(query, topK) as Array<{ rowid: number; score: number }>;

    if (results.length === 0) {
      console.log(chalk.yellow('  No results found. (Ensure FTS table is built via schema migration)'));
      return;
    }

    const getId = db.prepare(`SELECT id FROM messages WHERE rowid = ?`);
    
    for (let i = 0; i < results.length; i++) {
      const { rowid, score } = results[i];
      const msgRow = getId.get(rowid) as { id: string } | undefined;
      if (!msgRow) continue;

      const msg = getMessage(db, msgRow.id);
      if (msg) {
        console.log(chalk.white(`  ${i + 1}. Message [${msg.project_name}]`));
        console.log(chalk.gray(`     BM25 Score: ${Math.abs(score).toFixed(4)} | Time: ${msg.timestamp}`));
        console.log(chalk.dim(`     ${truncateString(msg.content, 120)}\n`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`  Search failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

export async function vsearchCommand(query: string, opts: { topK?: string; model?: string }): Promise<void> {
  if (!query) {
    console.error(chalk.red('Provide a search query: `code-insights vsearch "query"`'));
    process.exit(1);
  }

  const topK = parseInt(opts.topK ?? '5', 10);
  const config = buildEmbeddingConfig({ model: opts.model });
  
  console.log(chalk.cyan(`\n  Code Insights — Vector Search (Messages)\n`));
  console.log(chalk.gray(`  Query: "${query}"`));
  console.log(chalk.gray(`  Model: ${config.model}`));
  console.log(chalk.gray(`  Top-K: ${topK}\n`));

  const spinner = ora({ text: chalk.dim('Embedding query...'), color: 'cyan' }).start();

  try {
    const db = getDb();
    loadVectorExtension(db);

    const embedding = await embedOne(config, 'query', query);
    spinner.text = chalk.dim('Running KNN...');

    const { querySimilar } = await import('../embeddings/store.js');
    const results = querySimilar(db, 'message', embedding.vector, topK);

    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow('  No results found. Have you run `code-insights embeddings backfill --entity messages`?'));
      return;
    }

    for (let i = 0; i < results.length; i++) {
      const { id, distance } = results[i];
      const similarity = (1 / (1 + distance)).toFixed(3);
      const msg = getMessage(db, id);

      if (msg) {
        const scoreColor = parseFloat(similarity) > 0.7 ? chalk.green : parseFloat(similarity) > 0.4 ? chalk.yellow : chalk.red;
        console.log(chalk.white(`  ${i + 1}. Message [${msg.project_name}]`));
        console.log(chalk.gray(`     Score: ${scoreColor(similarity)} | Time: ${msg.timestamp}`));
        console.log(chalk.dim(`     ${truncateString(msg.content, 120)}\n`));
      }
    }
  } catch (error) {
    spinner.stop();
    console.error(chalk.red(`  Vector search failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

export async function queryCommand(query: string, opts: { topK?: string; model?: string }): Promise<void> {
  if (!query) {
    console.error(chalk.red('Provide a search query: `code-insights query "query"`'));
    process.exit(1);
  }

  const topK = parseInt(opts.topK ?? '5', 10);
  const config = buildEmbeddingConfig({ model: opts.model });
  
  console.log(chalk.cyan(`\n  Code Insights — Hybrid Search (Messages)\n`));
  console.log(chalk.gray(`  Query: "${query}"`));
  console.log(chalk.gray(`  Top-K: ${topK}\n`));

  const spinner = ora({ text: chalk.dim('Running hybrid search...'), color: 'cyan' }).start();

  try {
    const db = getDb();
    loadVectorExtension(db);

    // 1. Keyword Search (BM25)
    const keywordQuery = `
      SELECT rowid, bm25(messages_fts) as score
      FROM messages_fts
      WHERE messages_fts MATCH ?
      LIMIT 20
    `;
    const ftsResults = db.prepare(keywordQuery).all(query) as Array<{ rowid: number; score: number }>;
    const getId = db.prepare(`SELECT id FROM messages WHERE rowid = ?`);
    
    // RRF Map
    const rrfScores = new Map<string, { bm25Rank: number; knnRank: number; rrf: number }>();
    const k = 60; // Constant for RRF

    // Sort by absolute score (BM25 returns negative values for some sqlite versions, or lower is better? 
    // Actually, sqlite fts5 bm25 returns lower values for better matches, so sort ascending)
    ftsResults.sort((a, b) => a.score - b.score);
    ftsResults.forEach((res, index) => {
      const msgRow = getId.get(res.rowid) as { id: string } | undefined;
      if (msgRow) {
        rrfScores.set(msgRow.id, { bm25Rank: index + 1, knnRank: Infinity, rrf: 1 / (k + index + 1) });
      }
    });

    // 2. Vector Search (KNN)
    const embedding = await embedOne(config, 'query', query);
    const { querySimilar } = await import('../embeddings/store.js');
    const vecResults = querySimilar(db, 'message', embedding.vector, 20);

    vecResults.forEach((res, index) => {
      const existing = rrfScores.get(res.id) || { bm25Rank: Infinity, knnRank: Infinity, rrf: 0 };
      existing.knnRank = index + 1;
      existing.rrf += 1 / (k + index + 1);
      rrfScores.set(res.id, existing);
    });

    // 3. Combine and Sort (RRF)
    const sorted = Array.from(rrfScores.entries())
      .sort((a, b) => b[1].rrf - a[1].rrf)
      .slice(0, topK);

    spinner.stop();

    if (sorted.length === 0) {
      console.log(chalk.yellow('  No results found.'));
      return;
    }

    for (let i = 0; i < sorted.length; i++) {
      const [id, scores] = sorted[i];
      const msg = getMessage(db, id);

      if (msg) {
        console.log(chalk.white(`  ${i + 1}. Message [${msg.project_name}]`));
        console.log(chalk.gray(`     RRF Score: ${scores.rrf.toFixed(4)} (BM25 Rank: ${scores.bm25Rank === Infinity ? '-' : scores.bm25Rank}, KNN Rank: ${scores.knnRank === Infinity ? '-' : scores.knnRank})`));
        console.log(chalk.dim(`     ${truncateString(msg.content, 120)}\n`));
      }
    }
  } catch (error) {
    spinner.stop();
    console.error(chalk.red(`  Hybrid search failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

export function buildSearchCommands(): Command[] {
  const searchCmd = new Command('search')
    .description('Keyword search across messages (FTS5)')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Number of results', '5')
    .action((query, opts) => searchCommand(query, opts));

  const vsearchCmd = new Command('vsearch')
    .description('Vector similarity search across messages (KNN)')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Number of results', '5')
    .option('--model <name>', 'Embedding model for query')
    .action((query, opts) => vsearchCommand(query, opts));

  const queryCmd = new Command('query')
    .description('Hybrid search across messages (BM25 + KNN + RRF)')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Number of results', '5')
    .option('--model <name>', 'Embedding model for query')
    .action((query, opts) => queryCommand(query, opts));

  return [searchCmd, vsearchCmd, queryCmd];
}
