/**
 * embeddings command suite — manage vector embeddings for insights and messages.
 *
 * Subcommands:
 *   backfill   Backfill pending embeddings via Ollama
 *   status     Show embedding coverage stats
 *   recompute  Force re-compute stale embeddings
 *   search     KNN similarity search over insight embeddings
 */

import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import { getDb } from '../db/client.js';
import {
  DEFAULT_EMBEDDING_CONFIG,
  embedOne,
} from '../embeddings/client.js';
import type { EmbeddingConfig } from '../embeddings/client.js';
import {
  backfillEmbeddings,
  backfillAll,
} from '../embeddings/backfill.js';
import {
  loadVectorExtension,
  countVectors,
} from '../embeddings/store.js';
import { pruneEmbeddings } from '../embeddings/prune.js';
import { trackEvent, captureError, classifyError } from '../utils/telemetry.js';
import type Database from 'better-sqlite3';
import { loadConfig } from '../utils/config.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function buildEmbeddingConfig(overrides?: { model?: string; batchSize?: string }): EmbeddingConfig {
  const userConfig = loadConfig();
  const embeddingConfig = userConfig?.dashboard?.embedding;

  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(embeddingConfig?.baseUrl ? { baseUrl: embeddingConfig.baseUrl } : {}),
    ...(embeddingConfig?.model ? { model: embeddingConfig.model } : {}),
    ...(overrides?.model ? { model: overrides.model } : {}),
    ...(overrides?.batchSize ? { batchSize: parseInt(overrides.batchSize, 10) } : {}),
  };
}

function statusRowToInt(row: { n?: number | string }): number {
  if (typeof row.n === 'string') return parseInt(row.n, 10);
  return row.n ?? 0;
}

import cliProgress from 'cli-progress';

// ── embeddings backfill ───────────────────────────────────────────────────────

export async function embeddingsBackfillCommand(opts: {
  model?: string;
  batchSize?: string;
  entity?: string;
  quiet?: boolean;
}): Promise<void> {
  const log = opts.quiet ? () => {} : console.log.bind(console);
  const entityRaw = (opts.entity ?? 'both').toLowerCase();
  const entityFilter = entityRaw as 'insights' | 'messages' | 'both';

  if (!['insights', 'messages', 'both'].includes(entityFilter)) {
    console.error(chalk.red(`Invalid --entity: ${entityFilter}. Use insights, messages, or both.`));
    process.exit(1);
  }

  const config = buildEmbeddingConfig({
    model: opts.model,
    batchSize: opts.batchSize,
  });

  log(chalk.cyan('\n  Code Insights — Embedding Backfill\n'));
  log(chalk.gray(`  Model:     ${config.model}`));
  log(chalk.gray(`  Batch:     ${config.batchSize}`));
  log(chalk.gray(`  Entity:    ${entityFilter}`));
  log('');

  const db = getDb();
  loadVectorExtension(db);

  // Count pending/stale before starting
  const pendingInsights = statusRowToInt(
    db.prepare("SELECT COUNT(*) as n FROM insights WHERE embedding_status IN ('pending', 'stale')").get() as { n: number },
  );
  const pendingMessages = statusRowToInt(
    db.prepare("SELECT COUNT(*) as n FROM messages WHERE embedding_status IN ('pending', 'stale') AND type = 'user' AND content != ''").get() as { n: number },
  );

  if (entityFilter === 'insights' && pendingInsights === 0) {
    log(chalk.green('  No pending insight embeddings. Nothing to do.'));
    log('');
    return;
  }
  if (entityFilter === 'messages' && pendingMessages === 0) {
    log(chalk.green('  No pending message embeddings. Nothing to do.'));
    log('');
    return;
  }
  if (entityFilter === 'both' && pendingInsights === 0 && pendingMessages === 0) {
    log(chalk.green('  No pending embeddings. Nothing to do.'));
    log('');
    return;
  }

  const multiBar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: `  ${chalk.cyan('{bar}')} {percentage}% | {value}/{total} | {eta}s | {name}`,
  }, cliProgress.Presets.shades_classic);

  let insightsBar: cliProgress.SingleBar | undefined;
  let messagesBar: cliProgress.SingleBar | undefined;

  const t0 = Date.now();

  try {
    let statsInsights, statsMessages;

    if (entityFilter === 'insights') {
      insightsBar = multiBar.create(pendingInsights, 0, { name: 'Insights' });
      statsInsights = await backfillEmbeddings(config, 'insight', (c, t) => {
        if (!insightsBar) insightsBar = multiBar.create(t, 0, { name: 'Insights' });
        insightsBar.update(c);
      });
    } else if (entityFilter === 'messages') {
      messagesBar = multiBar.create(pendingMessages, 0, { name: 'Messages' });
      statsMessages = await backfillEmbeddings(config, 'message', (c, t) => {
        if (!messagesBar) messagesBar = multiBar.create(t, 0, { name: 'Messages' });
        messagesBar.update(c);
      });
    } else {
      if (pendingInsights > 0) insightsBar = multiBar.create(pendingInsights, 0, { name: 'Insights' });
      if (pendingMessages > 0) messagesBar = multiBar.create(pendingMessages, 0, { name: 'Messages' });
      
      const all = await backfillAll(config, (entity, c, t) => {
        if (entity === 'insight' && insightsBar) insightsBar.update(c);
        if (entity === 'message' && messagesBar) messagesBar.update(c);
      });
      statsInsights = all.insights;
      statsMessages = all.messages;
    }

    multiBar.stop();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Print results
    if (statsInsights) {
      console.log(chalk.white(`\n  Insights:`));
      console.log(chalk.gray(`    Total:     ${statsInsights.total}`));
      console.log(chalk.green(`    Computed:  ${statsInsights.computed}`));
      if (statsInsights.skipped > 0)
        console.log(chalk.dim(`    Skipped:   ${statsInsights.skipped}`));
      if (statsInsights.failed > 0)
        console.log(chalk.red(`    Failed:    ${statsInsights.failed}`));
    }

    if (statsMessages) {
      console.log(chalk.white(`\n  Messages:`));
      console.log(chalk.gray(`    Total:     ${statsMessages.total}`));
      console.log(chalk.green(`    Computed:  ${statsMessages.computed}`));
      if (statsMessages.skipped > 0)
        console.log(chalk.dim(`    Skipped:   ${statsMessages.skipped}`));
      if (statsMessages.failed > 0)
        console.log(chalk.red(`    Failed:    ${statsMessages.failed}`));
    }

    const totalComputed = (statsInsights?.computed ?? 0) + (statsMessages?.computed ?? 0);
    const totalFailed = (statsInsights?.failed ?? 0) + (statsMessages?.failed ?? 0);

    console.log('');
    if (totalComputed > 0) {
      console.log(chalk.green(`  Done: ${totalComputed} embeddings computed in ${elapsed}s`));
    }
    if (totalFailed > 0) {
      console.log(chalk.red(`  ${totalFailed} failed — run status for details`));
    }
    console.log('');

    trackEvent('cli_embeddings', {
      action: 'backfill',
      entity: entityFilter,
      computed: totalComputed,
      failed: totalFailed,
      duration_ms: Date.now() - t0,
      success: true,
    });
  } catch (error) {
    multiBar.stop();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const { error_type, error_message } = classifyError(error);

    console.log('');
    console.log(chalk.red(`  Backfill failed after ${elapsed}s`));
    console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
    console.log('');

    trackEvent('cli_embeddings', {
      action: 'backfill',
      entity: entityFilter,
      duration_ms: Date.now() - t0,
      success: false,
      error_type,
      error_message,
    });
    captureError(error, { command: 'embeddings backfill', error_type });
    process.exit(1);
  }
}

// ── embeddings status ──────────────────────────────────────────────────────────

export async function embeddingsStatusCommand(opts: { quiet?: boolean }): Promise<void> {
  const log = opts.quiet ? () => {} : console.log.bind(console);

  try {
    const db = getDb();
    loadVectorExtension(db);

    log(chalk.cyan('\n  Code Insights — Embedding Status\n'));

    // --- Row counts by embedding_status ---
    log(chalk.white('  Insights by status:'));
    const insightStatuses = db.prepare(`
      SELECT embedding_status, COUNT(*) as n
      FROM insights
      GROUP BY embedding_status
    `).all() as Array<{ embedding_status: string; n: number }>;

    if (insightStatuses.length === 0) {
      log(chalk.dim('    No insight rows.'));
    } else {
      for (const row of insightStatuses) {
        const color = row.embedding_status === 'computed' ? chalk.green
          : row.embedding_status === 'failed' ? chalk.red
          : row.embedding_status === 'stale' ? chalk.yellow
          : chalk.gray;
        log(color(`    ${row.embedding_status.padEnd(12)} ${row.n}`));
      }
    }

    log(chalk.white('\n  Messages by status:'));
    const messageStatuses = db.prepare(`
      SELECT embedding_status, COUNT(*) as n
      FROM messages
      WHERE type = 'user' AND content != ''
      GROUP BY embedding_status
    `).all() as Array<{ embedding_status: string; n: number }>;

    if (messageStatuses.length === 0) {
      log(chalk.dim('    No message rows.'));
    } else {
      for (const row of messageStatuses) {
        const color = row.embedding_status === 'computed' ? chalk.green
          : row.embedding_status === 'failed' ? chalk.red
          : row.embedding_status === 'stale' ? chalk.yellow
          : chalk.gray;
        log(color(`    ${row.embedding_status.padEnd(12)} ${row.n}`));
      }
    }

    // --- Embedding metadata ---
    log(chalk.white('\n  Embedding metadata:'));
    const metadataRows = db.prepare(`
      SELECT entity_type, model, dim, COUNT(*) as n
      FROM embedding_metadata
      GROUP BY entity_type, model, dim
      ORDER BY entity_type
    `).all() as Array<{ entity_type: string; model: string; dim: number; n: number }>;

    if (metadataRows.length === 0) {
      log(chalk.dim('    No embeddings computed yet.'));
    } else {
      for (const row of metadataRows) {
        log(chalk.gray(`    ${row.entity_type.padEnd(8)} ${row.model} (dim=${row.dim}) — ${row.n} vectors`));
      }
    }

    // --- sqlite-vec virtual table counts ---
    log(chalk.white('\n  sqlite-vec index:'));
    let insightVecCount: number | null = null;
    let messageVecCount: number | null = null;
    try {
      insightVecCount = countVectors(db, 'insight');
      log(chalk.gray(`    vec_insights:  ${insightVecCount} vectors`));
    } catch {
      log(chalk.dim('    vec_insights:  not created yet'));
    }
    try {
      messageVecCount = countVectors(db, 'message');
      log(chalk.gray(`    vec_messages:  ${messageVecCount} vectors`));
    } catch {
      log(chalk.dim('    vec_messages:  not created yet'));
    }

    // Warn on mixed models or metadata/vector count drift
    const insightMetaRows = metadataRows.filter(r => r.entity_type === 'insight');
    const messageMetaRows = metadataRows.filter(r => r.entity_type === 'message');
    const insightMetaTotal = insightMetaRows.reduce((sum, r) => sum + r.n, 0);
    const messageMetaTotal = messageMetaRows.reduce((sum, r) => sum + r.n, 0);
    const hasMixedModels = insightMetaRows.length > 1 || messageMetaRows.length > 1;
    const hasInsightDrift = insightVecCount !== null && insightMetaTotal !== insightVecCount;
    const hasMessageDrift = messageVecCount !== null && messageMetaTotal !== messageVecCount;

    if (hasMixedModels || hasInsightDrift || hasMessageDrift) {
      log(chalk.yellow('\n  Warning: mixed embedding models or metadata/vector index drift detected.'));
      log(chalk.yellow('  Run `code-insights embeddings prune --dry-run` to inspect stale or orphaned records.'));
    }

    log('');
    trackEvent('cli_embeddings', { action: 'status', success: true });
  } catch (error) {
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_embeddings', { action: 'status', success: false, error_type, error_message });
    captureError(error, { command: 'embeddings status', error_type });
    console.error(chalk.red(`  Status command failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
    if (!opts.quiet) process.exit(1);
  }
}

// ── embeddings recompute ───────────────────────────────────────────────────────

export async function embeddingsRecomputeCommand(opts: {
  sessionId?: string;
  projectId?: string;
  all?: boolean;
  failed?: boolean;
  rebuild?: boolean;
}): Promise<void> {
  const db = getDb();
  loadVectorExtension(db);

  console.log(chalk.cyan('\n  Code Insights — Embedding Recompute\n'));

  let affected = 0;

  if (opts.all) {
    // Mark all computed/stale/failed rows as pending
    const iResult = db.prepare(`
      UPDATE insights SET embedding_status = 'pending' WHERE embedding_status IN ('computed', 'stale', 'failed')
    `).run();
    const mResult = db.prepare(`
      UPDATE messages SET embedding_status = 'pending' WHERE embedding_status IN ('computed', 'stale', 'failed')
    `).run();
    affected = (iResult.changes ?? 0) + (mResult.changes ?? 0);
    console.log(chalk.gray(`  Marked ${affected} rows as pending (all entities).`));
  } else if (opts.failed) {
    // Mark only failed rows as pending
    const iResult = db.prepare(`
      UPDATE insights SET embedding_status = 'pending' WHERE embedding_status = 'failed'
    `).run();
    const mResult = db.prepare(`
      UPDATE messages SET embedding_status = 'pending' WHERE embedding_status = 'failed'
    `).run();
    affected = (iResult.changes ?? 0) + (mResult.changes ?? 0);
    console.log(chalk.gray(`  Marked ${affected} failed rows as pending to be retried.`));
  } else if (opts.sessionId) {
    // Mark insights + messages for a specific session
    const iResult = db.prepare(`
      UPDATE insights SET embedding_status = 'stale' WHERE session_id = ? AND embedding_status = 'computed'
    `).run(opts.sessionId);
    const mResult = db.prepare(`
      UPDATE messages SET embedding_status = 'stale' WHERE session_id = ? AND embedding_status = 'computed'
    `).run(opts.sessionId);
    affected = (iResult.changes ?? 0) + (mResult.changes ?? 0);
    if (affected === 0) {
      console.log(chalk.yellow(`  No computed embeddings found for session ${opts.sessionId}.`));
    } else {
      console.log(chalk.gray(`  Marked ${affected} rows as stale for session ${opts.sessionId}.`));
    }
  } else if (opts.projectId) {
    const iResult = db.prepare(`
      UPDATE insights SET embedding_status = 'stale' WHERE project_id = ? AND embedding_status = 'computed'
    `).run(opts.projectId);
    const mResult = db.prepare(`
      UPDATE messages SET embedding_status = 'stale' WHERE session_id IN (
        SELECT id FROM sessions WHERE project_id = ?
      ) AND embedding_status = 'computed'
    `).run(opts.projectId);
    affected = (iResult.changes ?? 0) + (mResult.changes ?? 0);
    if (affected === 0) {
      console.log(chalk.yellow(`  No computed embeddings found for project ${opts.projectId}.`));
    } else {
      console.log(chalk.gray(`  Marked ${affected} rows as stale for project ${opts.projectId}.`));
    }
  } else {
    console.log(chalk.yellow('  Specify --session-id, --project-id, or --all.'));
    process.exit(1);
  }

  if (opts.rebuild && opts.all) {
    db.exec(`DROP TABLE IF EXISTS vec_insights`);
    db.exec(`DROP TABLE IF EXISTS vec_messages`);
    db.exec(`DELETE FROM embedding_metadata`);
    db.exec(`DELETE FROM entity_chunks`);
    console.log(chalk.gray(`  Dropped vector store tables and cleared embedding metadata/chunks to allow rebuilding from scratch.`));
  } else if (opts.rebuild) {
    console.log(chalk.yellow(`  Warning: --rebuild is only supported with --all. Vector tables were not dropped.`));
  }

  console.log('');
  if (affected > 0) {
    console.log(chalk.dim('  Run `code-insights embeddings backfill` to recompute.'));
  }
  console.log('');

  trackEvent('cli_embeddings', {
    action: 'recompute',
    scope: opts.all ? 'all' : opts.failed ? 'failed' : opts.sessionId ? 'session' : 'project',
    affected,
    success: true,
  });
}

// ── embeddings search ──────────────────────────────────────────────────────────

export async function embeddingsSearchCommand(
  query: string | undefined,
  opts: { topK?: string; model?: string; quiet?: boolean },
): Promise<void> {
  if (!query || query.trim().length === 0) {
    console.error(chalk.red('  Provide a search query: `code-insights embeddings search "your query"`'));
    process.exit(1);
  }

  const config = buildEmbeddingConfig({ model: opts.model });
  const topK = parseInt(opts.topK ?? '5', 10);

  console.log(chalk.cyan('\n  Code Insights — Embedding Search\n'));
  console.log(chalk.gray(`  Query: "${query}"`));
  console.log(chalk.gray(`  Model: ${config.model}`));
  console.log(chalk.gray(`  Top-K: ${topK}`));
  console.log('');

  const spinner = ora({ text: chalk.dim('Embedding query...'), color: 'cyan' });
  spinner.start();

  try {
    const db = getDb();
    loadVectorExtension(db);

    // Embed the query
    const embedding = await embedOne(config, 'query', query);
    spinner.text = chalk.dim('Running KNN...');

    // Import querySimilar on demand (already loaded store above)
    const { querySimilar } = await import('../embeddings/store.js');
    const results = querySimilar(db, 'insight', embedding.vector, topK);

    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow('  No results. Have you run `embeddings backfill`?'));
      console.log('');
      return;
    }

    console.log(chalk.white(`  Top ${results.length} results:\n`));

    // Load insight text for display
    const getInsight = db.prepare(`
      SELECT i.id, i.type, i.project_name, i.title, i.summary, i.confidence
      FROM insights i
      JOIN sessions s ON s.id = i.session_id
      WHERE i.id = ? AND s.deleted_at IS NULL
    `);

    for (let i = 0; i < results.length; i++) {
      const { id, distance } = results[i];
      const similarity = (1 / (1 + distance)).toFixed(3);
      const insight = getInsight.get(id) as {
        id: string;
        type: string;
        project_name: string;
        title: string;
        summary: string;
        confidence: number;
      } | undefined;

      if (insight) {
        const scoreColor = parseFloat(similarity) > 0.7 ? chalk.green
          : parseFloat(similarity) > 0.4 ? chalk.yellow
          : chalk.red;
        console.log(chalk.white(`  ${i + 1}. ${insight.title}`));
        console.log(chalk.gray(`     Type: ${insight.type}  Project: ${insight.project_name}`));
        console.log(chalk.gray(`     Score: ${scoreColor(similarity)}  (distance: ${distance.toFixed(4)})`));
        if (insight.summary) {
          const truncated = insight.summary.length > 120
            ? insight.summary.slice(0, 117) + '...'
            : insight.summary;
          console.log(chalk.dim(`     ${truncated}`));
        }
        console.log(chalk.dim(`     ${id}`));
      } else {
        console.log(chalk.dim(`  ${i + 1}. ${id}  (similarity: ${similarity})`));
      }
      console.log('');
    }

    trackEvent('cli_embeddings', {
      action: 'search',
      results_count: results.length,
      top_k: topK,
      success: true,
    });
  } catch (error) {
    spinner.stop();
    const { error_type, error_message } = classifyError(error);
    console.error(chalk.red(`  Search failed: ${error instanceof Error ? error.message : String(error)}`));
    console.error('');
    trackEvent('cli_embeddings', {
      action: 'search',
      success: false,
      error_type,
      error_message,
    });
    captureError(error, { command: 'embeddings search', error_type });
    process.exit(1);
  }
}

// ── embeddings prune ───────────────────────────────────────────────────────────

export async function embeddingsPruneCommand(opts: {
  dryRun?: boolean;
  model?: string;
  allModels?: boolean;
  quiet?: boolean;
}): Promise<void> {
  const log = opts.quiet ? () => {} : console.log.bind(console);
  const dryRun = Boolean(opts.dryRun);
  const targetModel = opts.allModels ? undefined : buildEmbeddingConfig({ model: opts.model }).model;

  try {
    const db = getDb();
    const report = pruneEmbeddings(db, { targetModel, dryRun });

    log(chalk.cyan('\n  Code Insights — Embedding Prune\n'));
    log(chalk.gray(`  Mode:         ${dryRun ? 'dry-run (no changes written)' : 'apply'}`));
    log(chalk.gray(`  Target model: ${report.targetModel ?? 'any (orphans/ghosts only)'}`));
    log('');
    log(chalk.white('  Metadata removed:'));
    log(chalk.gray(`    Legacy flat rows (pre-V14):  ${report.legacyFlatRemoved}`));
    log(chalk.gray(`    Orphan entity rows:          ${report.orphanEntityRemoved}`));
    log(chalk.gray(`    Missing-vector ghosts:       ${report.missingVectorRemoved}`));
    log(chalk.gray(`    Off-model rows:              ${report.wrongModelRemoved}`));
    log(chalk.gray(`    Total metadata rows:         ${report.totalMetadataRemoved}`));
    log(chalk.white('\n  Vectors & chunks removed:'));
    log(chalk.gray(`    vec_insights vectors:        ${report.vecInsightsRemoved} (dangling: ${report.danglingInsightVectorsRemoved})`));
    log(chalk.gray(`    vec_messages vectors:        ${report.vecMessagesRemoved} (dangling: ${report.danglingMessageVectorsRemoved})`));
    log(chalk.gray(`    Orphan insight chunks:       ${report.orphanInsightChunksRemoved}`));
    log(chalk.gray(`    Orphan message chunks:       ${report.orphanMessageChunksRemoved}`));
    log(chalk.white('\n  Re-queued entities:'));
    log(chalk.gray(`    Insights marked pending:     ${report.requeuedInsights}`));
    log(chalk.gray(`    Messages marked pending:     ${report.requeuedMessages}`));
    log('');

    if (!dryRun && (report.requeuedInsights > 0 || report.requeuedMessages > 0)) {
      log(chalk.dim('  Run `code-insights embeddings backfill` to recompute re-queued entities.\n'));
    }

    trackEvent('cli_embeddings', {
      action: 'prune',
      dry_run: dryRun,
      total_metadata_removed: report.totalMetadataRemoved,
      vec_insights_removed: report.vecInsightsRemoved,
      vec_messages_removed: report.vecMessagesRemoved,
      requeued: report.requeuedInsights + report.requeuedMessages,
      success: true,
    });
  } catch (error) {
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_embeddings', { action: 'prune', success: false, error_type, error_message });
    captureError(error, { command: 'embeddings prune', error_type });
    console.error(chalk.red(`  Prune failed: ${error instanceof Error ? error.message : String(error)}`));
    if (!opts.quiet) process.exit(1);
  }
}

// ── Commander command tree ─────────────────────────────────────────────────────

export function buildEmbeddingsCommand(): Command {
  const embeddingsCmd = new Command('embeddings')
    .description('Manage vector embeddings for insights and messages');

  embeddingsCmd
    .command('backfill')
    .description('Backfill pending embeddings via Ollama')
    .option('--model <name>', 'Embedding model (default: configured model or embeddinggemma-2:440m)')
    .option('--batch-size <n>', 'Batch size (default: 50)', '50')
    .option('--entity <type>', 'Entity type: insights, messages, or both (default: both)', 'both')
    .option('-q, --quiet', 'Suppress output')
    .action((opts) =>
      embeddingsBackfillCommand({
        model: opts.model,
        batchSize: opts.batchSize,
        entity: opts.entity,
        quiet: opts.quiet,
      }),
    );

  embeddingsCmd
    .command('status')
    .description('Show embedding coverage and vector index stats')
    .option('-q, --quiet', 'Suppress output')
    .action((opts) => embeddingsStatusCommand({ quiet: opts.quiet }));

  embeddingsCmd
    .command('recompute')
    .description('Force re-compute embeddings for stale entries')
    .option('--session-id <id>', 'Recompute for a specific session')
    .option('--project-id <id>', 'Recompute for a specific project')
    .option('--all', 'Recompute all computed/stale entities')
    .option('--failed', 'Recompute all failed entities')
    .option('--rebuild', 'Drop vector store tables to rebuild from scratch with a new model (use with --all)')
    .action((opts) =>
      embeddingsRecomputeCommand({
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        all: opts.all,
        failed: opts.failed,
        rebuild: opts.rebuild,
      }),
    );

  embeddingsCmd
    .command('prune')
    .description('Remove orphaned, legacy, and off-model embedding metadata and vectors')
    .option('--dry-run', 'Preview removals without modifying the database')
    .option('--model <name>', 'Target model to keep (default: configured model or embeddinggemma-2:440m)')
    .option('--all-models', 'Keep all models and prune only orphans, legacy flat rows, and missing-vector ghosts')
    .option('-q, --quiet', 'Suppress output')
    .action((opts) =>
      embeddingsPruneCommand({
        dryRun: opts.dryRun,
        model: opts.model,
        allModels: opts.allModels,
        quiet: opts.quiet,
      }),
    );

  embeddingsCmd
    .command('search <query>')
    .description('KNN similarity search over insight embeddings')
    .option('--top-k <n>', 'Number of results (default: 5)', '5')
    .option('--model <name>', 'Embedding model for query (default: configured model or embeddinggemma-2:440m)')
    .option('-q, --quiet', 'Suppress output')
    .action((query: string, opts) =>
      embeddingsSearchCommand(query, {
        topK: opts.topK,
        model: opts.model,
        quiet: opts.quiet,
      }),
    );

  return embeddingsCmd;
}
