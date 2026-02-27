import chalk from 'chalk';
import { loadConfig, loadSyncState, isConfigured, getConfigDir, hasWebConfig, loadWebConfig, resolveDataSourcePreference } from '../utils/config.js';
import { initializeFirebase, getProjects, getProjectToolCounts } from '../firebase/client.js';
import { getAllProviders } from '../providers/registry.js';
import { trackEvent } from '../utils/telemetry.js';

/**
 * Show Code Insights status
 */
export async function statusCommand(): Promise<void> {
  console.log(chalk.cyan('\n📊 Code Insights Status\n'));

  // Check configuration
  console.log(chalk.white('Configuration:'));
  const preference = resolveDataSourcePreference();
  if (isConfigured()) {
    console.log(chalk.green(`  ✓ Configured at ${getConfigDir()}`));
    const config = loadConfig();
    if (config) {
      console.log(chalk.gray(`    Project: ${config.firebase?.projectId ?? '(local)'}`));
    }
    console.log(chalk.gray(`    Data source: ${preference}`));
  } else {
    console.log(chalk.yellow('  ○ Not configured (running in zero-config mode)'));
    console.log(chalk.gray('    Stats work without config: code-insights stats'));
    console.log(chalk.gray('    To configure Firebase: code-insights init'));
  }

  // Discover local sessions across all providers
  console.log(chalk.white('\nLocal Sessions:'));
  const providers = getAllProviders();
  let totalLocal = 0;
  for (const provider of providers) {
    try {
      const files = await provider.discover();
      if (files.length > 0) {
        console.log(chalk.green(`  ✓ ${provider.getProviderName()}: ${files.length} sessions`));
        totalLocal += files.length;
      }
    } catch {
      // Provider not available on this machine (e.g., no Cursor installed)
    }
  }
  if (totalLocal === 0) {
    console.log(chalk.yellow('  ○ No sessions found from any tool'));
  }

  // Check sync state
  console.log(chalk.white('\nSync State:'));
  const syncState = loadSyncState();
  if (syncState.lastSync) {
    const lastSync = new Date(syncState.lastSync);
    const syncedFiles = Object.keys(syncState.files).length;
    console.log(chalk.green(`  ✓ Last sync: ${lastSync.toLocaleString()}`));
    console.log(chalk.gray(`    ${syncedFiles} files tracked`));
  } else {
    console.log(chalk.yellow('  ⚠ Never synced'));
    console.log(chalk.gray('    Run `code-insights sync` to sync'));
  }

  if (preference === 'local') {
    // Local mode — skip Firebase connection check
    console.log(chalk.white('\nFirebase:'));
    console.log(chalk.gray('  ○ Not applicable (data source is local)'));
    console.log(chalk.gray('    Use `code-insights stats --local` for session analytics'));
    console.log(chalk.gray('    To switch: code-insights config set-source firebase'));
  } else {
    // Check Firebase connection
    console.log(chalk.white('\nFirebase:'));
    const config = loadConfig();
    if (config) {
      try {
        initializeFirebase(config);
        const [projects, toolCounts] = await Promise.all([
          getProjects(),
          getProjectToolCounts(),
        ]);
        console.log(chalk.green('  ✓ Connected'));
        console.log(chalk.gray(`    ${projects.length} projects in Firestore`));

        if (projects.length > 0) {
          console.log(chalk.white('\nSynced Projects:'));
          for (const project of projects.slice(0, 5)) {
            const perTool = toolCounts.get(project.id);
            if (perTool && perTool.size > 1) {
              const breakdown = [...perTool.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([tool, count]) => `${tool} ${count}`)
                .join(', ');
              console.log(chalk.gray(`    ${project.name} (${project.sessionCount} sessions: ${breakdown})`));
            } else {
              console.log(chalk.gray(`    ${project.name} (${project.sessionCount} sessions)`));
            }
          }
          if (projects.length > 5) {
            console.log(chalk.gray(`    ... and ${projects.length - 5} more`));
          }
        }
      } catch (error) {
        console.log(chalk.red('  ✗ Connection failed'));
        console.log(chalk.gray(`    ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    }

    // Check web dashboard config
    console.log(chalk.white('\nWeb Dashboard:'));
    if (hasWebConfig()) {
      const webConfig = loadWebConfig();
      console.log(chalk.green('  ✓ Configured'));
      if (webConfig && typeof webConfig.projectId === 'string') {
        console.log(chalk.gray(`    Project: ${webConfig.projectId}`));
      }
      console.log(chalk.gray('    Run "code-insights connect" to get dashboard URL'));
    } else {
      console.log(chalk.yellow('  ○ Not configured'));
      console.log(chalk.gray('    Run "code-insights init" to configure'));
    }
  }

  console.log('');
  trackEvent('status', true);
}

