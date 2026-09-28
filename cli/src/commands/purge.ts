import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb, getDbPath } from '../db/client.js';
import { purgeSessions, type PurgeOptions } from '../db/purge.js';

interface PurgeCommandOptions {
  dryRun?: boolean;
  reason?: string;
  quiet?: boolean;
  confirm?: boolean;
}

export async function purgeCommand(
  sessionId: string | undefined,
  options: PurgeCommandOptions
): Promise<void> {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const db = getDb();

  const sessionIds = sessionId ? [sessionId] : undefined;

  // If purging all soft-deleted sessions and no confirmation flag, confirm
  if (!sessionId && !options.dryRun && !options.confirm) {
    const pendingRows = db.prepare('SELECT id, COALESCE(custom_title, generated_title, summary, id) as title FROM sessions WHERE deleted_at IS NOT NULL').all() as Array<{ id: string; title: string }>;

    if (pendingRows.length === 0) {
      log(chalk.green('\n  No soft-deleted sessions found to purge.\n'));
      return;
    }

    log(chalk.cyan.bold('\n  Code Insights — Purge Soft-Deleted Sessions\n'));
    log(chalk.yellow(`  Found ${pendingRows.length} session(s) marked for deletion:\n`));
    for (const r of pendingRows.slice(0, 10)) {
      log(`  ${chalk.dim('·')} ${chalk.white(r.id)}: ${chalk.gray(r.title.slice(0, 60))}`);
    }
    if (pendingRows.length > 10) {
      log(chalk.dim(`  ... and ${pendingRows.length - 10} more`));
    }
    log('');
  }

  const spinner = ora('Purging sessions and registering tombstones...').start();
  try {
    const result = purgeSessions(db, {
      sessionIds,
      reason: options.reason || 'User requested purge',
      dryRun: options.dryRun,
    });

    if (options.dryRun) {
      spinner.info(`Dry run: ${result.purgedCount} session(s) would be permanently purged and tombstoned.`);
    } else {
      spinner.succeed(`Permanently purged ${result.purgedCount} session(s).`);
      log(chalk.gray('  Tombstones added to deleted_sessions table (resync will never re-import them).\n'));
    }
  } catch (error: any) {
    spinner.fail(`Purge failed: ${error?.message || error}`);
    throw error;
  }
}

export const buildPurgeCommand = (): Command => {
  return new Command('purge')
    .description('Hard-delete soft-deleted sessions and tombstone them to prevent resync re-import')
    .argument('[session_id]', 'Specific session ID to purge (defaults to all soft-deleted sessions)')
    .option('--dry-run', 'Preview sessions that would be purged without deleting')
    .option('--reason <reason>', 'Audit reason for tombstone entry', 'User purge')
    .option('-y, --confirm', 'Skip interactive confirmation')
    .option('-q, --quiet', 'Suppress output')
    .action(purgeCommand);
};
