import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb, getDbPath } from '../db/client.js';
import { reprocessDatabase, type ReprocessOptions } from '../db/reprocess.js';
import { runSync } from './sync.js';

interface CommandOptions {
  dryRun?: boolean;
  resync?: boolean;
  rebuildFts?: boolean;
  quiet?: boolean;
}

export async function reprocessCommand(options: CommandOptions): Promise<void> {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const noopSpinner = {
    start: function () { return this; },
    succeed: function () { return this; },
    fail: function () { return this; },
    warn: function () { return this; },
    info: function () { return this; },
    stop: function () { return this; },
  };
  const createSpinner = options.quiet ? () => noopSpinner : ora;

  log(chalk.cyan.bold('\n  Code Insights — Local Data Reprocessor\n'));
  log(chalk.gray(`  Database: ${getDbPath()}`));
  if (options.dryRun) {
    log(chalk.yellow('  Mode: Dry Run (no database mutations)\n'));
  } else {
    log(chalk.green('  Mode: Zero-cost local backfill (0 API calls)\n'));
  }

  // 1. Resync raw local logs if requested
  if (options.resync) {
    log(chalk.white('1. Resyncing raw session files from local disk...'));
    try {
      const syncResult = await runSync({ force: true, quiet: options.quiet });
      log(chalk.green(`   Synced ${syncResult.syncedCount} sessions (${syncResult.messageCount} messages) across providers.\n`));
    } catch (err: any) {
      log(chalk.red(`   Resync warning: ${err?.message || err}\n`));
    }
  }

  // 2. Reprocess in-place data
  const spinner = createSpinner('Reprocessing local database tables...').start();
  try {
    const db = getDb();
    const result = reprocessDatabase(db, {
      dryRun: options.dryRun,
      rebuildFts: options.rebuildFts,
    });

    spinner.succeed('Local data reprocessing complete!\n');

    // Summary output
    log(chalk.white.bold('  Reprocessing Summary:'));
    log(
      `  ${chalk.cyan('•')} Session Steps (FCA v15): ` +
      chalk.green(`${result.sessionSteps.stepsInserted} steps `) +
      chalk.gray(`across ${result.sessionSteps.sessionsProcessed} sessions`)
    );
    log(
      `  ${chalk.cyan('•')} Decision Attribution:    ` +
      chalk.green(`${result.decisions.updatedCount} legacy decisions updated `) +
      chalk.gray(`(${result.decisions.byAttribution.user} user, ${result.decisions.byAttribution.agent} agent, ${result.decisions.byAttribution.collaborative} collaborative)`)
    );
    log(
      `  ${chalk.cyan('•')} Facet Friction Attribution: ` +
      chalk.green(`${result.facets.updatedCount} friction records normalized`)
    );
    log(
      `  ${chalk.cyan('•')} Full-Text Search (FTS5):    ` +
      (result.ftsRebuilt ? chalk.green('Rebuilt successfully') : chalk.gray('Skipped / unchanged'))
    );
    log('');
  } catch (error: any) {
    spinner.fail(`Reprocessing failed: ${error?.message || error}`);
    throw error;
  }
}

export const buildReprocessCommand = (): Command => {
  return new Command('reprocess')
    .description('Reprocess and backfill local database data to reflect updated schema intentions without LLM API calls')
    .option('--dry-run', 'Preview changes without modifying the database')
    .option('--resync', 'Also resync raw local session logs from disk first')
    .option('--no-fts', 'Skip rebuilding the FTS5 full-text search index')
    .option('-q, --quiet', 'Suppress output')
    .action(reprocessCommand);
};
