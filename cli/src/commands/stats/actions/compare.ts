// ──────────────────────────────────────────────────────
// stats compare — Plan vs Pay-As-You-Go API comparison
// ──────────────────────────────────────────────────────

import ora from 'ora';
import { trackEvent, identifyUser } from '../../../utils/telemetry.js';
import { resolveDataSource } from '../data/source.js';
import { periodStartDate, computeOverview } from '../data/aggregation.js';
import type { StatsFlags, SessionQueryOptions } from '../data/types.js';
import { colors } from '../render/colors.js';
import { handleStatsError } from './error-handler.js';
import { formatMoney, formatPeriodLabel, formatPercent } from '../render/format.js';
import { sectionHeader, metricGrid } from '../render/layout.js';
import { showTip } from '../../../utils/tips.js';
import { loadConfig } from '../../../utils/config.js';
import { getEffectivePlans, calculatePlansBreakdown } from '../../../utils/plans.js';

export async function compareAction(flags: StatsFlags): Promise<void> {
  const startTime = Date.now();
  try {
    const source = await resolveDataSource(flags);

    const spinner = ora({ text: 'Syncing...', indent: 2 }).start();
    try {
      const prepResult = await source.prepare(flags);
      spinner.succeed(prepResult.message);
    } catch {
      spinner.warn('Sync failed (showing cached data)');
    }

    void identifyUser();

    const opts: SessionQueryOptions = {
      periodStart: periodStartDate(flags.period),
      sourceTool: flags.source,
    };
    if (flags.project) {
      const resolved = await source.resolveProjectId(flags.project);
      opts.projectId = resolved.projectId;
    }

    const sessions = await source.getSessions(opts);
    const periodLabel = formatPeriodLabel(flags.period);

    if (sessions.length === 0) {
      console.log(sectionHeader('PLAN VS PAY-AS-YOU-GO COMPARISON', periodLabel));
      console.log(`\n  No sessions found in the ${periodLabel.toLowerCase()}.\n`);
      return;
    }

    const config = loadConfig();
    const plans = getEffectivePlans(config);
    const overview = computeOverview(sessions, flags.period, plans);
    const planBreakdown = calculatePlansBreakdown(sessions, flags.period, plans);

    const actualSpend = overview.actualCost ?? 0;
    const apiValue = overview.totalCost;
    const netSavings = overview.totalSavings ?? Math.max(0, apiValue - actualSpend);
    const savingsPercent = apiValue > 0 ? (netSavings / apiValue) * 100 : 0;
    const roiMultiplier = actualSpend > 0 ? (apiValue / actualSpend) : 1;

    console.log(sectionHeader('PLAN VS PAY-AS-YOU-GO COMPARISON', periodLabel));
    console.log();
    console.log(metricGrid([
      { label: 'Your Spend', value: formatMoney(actualSpend) },
      { label: 'Pay-As-You-Go API', value: formatMoney(apiValue) },
      { label: 'Absorbed Value', value: `${formatMoney(netSavings)} (${formatPercent(savingsPercent)})` },
      { label: 'Compute Leverage', value: `${roiMultiplier.toFixed(1)}x exploratory volume` },
    ]));

    // Plans comparison table
    console.log(sectionHeader('SUBSCRIPTION PLANS VS PAY-AS-YOU-GO API'));
    console.log();
    const activePlans = planBreakdown.filter(p => p.sessionCount > 0);

    for (const p of activePlans) {
      const isSub = p.type === 'subscription';
      const badge = isSub
        ? colors.success(`[Plan: $${(p.monthlyFee ?? 0).toFixed(2)}/mo]`)
        : p.type === 'free'
        ? colors.label('[Free / Local]')
        : colors.warning('[Pay-As-You-Go]');

      const planRoi = p.actualCost > 0 ? (p.tokenValue / p.actualCost).toFixed(1) + 'x' : '1.0x';
      const spendFormatted = formatMoney(p.actualCost);
      const apiFormatted = formatMoney(p.tokenValue);
      const saveFormatted = p.savings > 0 ? colors.success(`+$${p.savings.toFixed(2)} (${planRoi} leverage)`) : colors.label('$0.00');

      console.log(`  ${colors.value(p.name)} ${badge}`);
      console.log(`    ${colors.label('Your Spend:')} ${spendFormatted}    ${colors.label('Pay-As-You-Go API:')} ${apiFormatted}    ${colors.label('Absorbed Value:')} ${saveFormatted}    ${colors.label(`(${p.sessionCount} sessions)`)}`);
      console.log(`    ${colors.hint(`Tools: ${p.tools.join(', ')}`)}`);
      console.log();
    }

    // Source tools breakdown with API equivalent
    if (overview.sourceTools.length >= 2) {
      console.log(sectionHeader('PER-SOURCE BREAKDOWN'));
      console.log();
      for (const st of overview.sourceTools) {
        const subBadge = st.isSubscription ? colors.success('[Plan]') : colors.label('[Pay-as-you-go]');
        const spend = formatMoney(st.actualCost ?? st.cost);
        const apiVal = formatMoney(st.apiCost ?? st.cost);
        const saved = st.savings && st.savings > 0 ? colors.success(`(Absorbed ${formatMoney(st.savings)})`) : '';
        console.log(`  ${colors.value(st.name.padEnd(16))} ${subBadge}  ${colors.label(`${st.count} sessions`)}`);
        console.log(`    Spend: ${spend}    API Equivalent: ${apiVal}  ${saved}`);
      }
      console.log();
    }

    console.log(colors.hint('→ Edit plan fees anytime: code-insights config plans --set <planId>.monthlyFee=<amount>'));
    console.log();

    trackEvent('cli_stats', { duration_ms: Date.now() - startTime, subcommand: 'compare', period: flags.period, source_filter: flags.source ?? null, success: true });
    showTip('stats');
  } catch (err) {
    trackEvent('cli_stats', { duration_ms: Date.now() - startTime, subcommand: 'compare', period: flags.period, source_filter: flags.source ?? null, success: false });
    handleStatsError(err);
  }
}
