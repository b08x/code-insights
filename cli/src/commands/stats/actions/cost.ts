// ──────────────────────────────────────────────────────
// stats cost — Cost breakdown by project, model, tokens
// ──────────────────────────────────────────────────────

import ora from 'ora';
import { trackEvent, identifyUser } from '../../../utils/telemetry.js';
import { resolveDataSource } from '../data/source.js';
import { periodStartDate, computeCostBreakdown } from '../data/aggregation.js';
import type { StatsFlags, SessionQueryOptions } from '../data/types.js';
import { colors } from '../render/colors.js';
import { handleStatsError } from './error-handler.js';
import {
  formatMoney,
  formatTokens,
  formatPercent,
  formatPeriodLabel,
} from '../render/format.js';
import { sparkline, sparklineLabels } from '../render/charts.js';
import { barChart } from '../render/charts.js';
import { sectionHeader, metricGrid, getBarWidth } from '../render/layout.js';
import { showTip } from '../../../utils/tips.js';
import { loadConfig } from '../../../utils/config.js';
import { getEffectivePlans } from '../../../utils/plans.js';

export async function costAction(flags: StatsFlags): Promise<void> {
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

    // Identify user now that DB is open (updates total_sessions person property)
    void identifyUser();

    // Resolve project filter
    const opts: SessionQueryOptions = {
      periodStart: periodStartDate(flags.period),
      sourceTool: flags.source,
    };
    if (flags.project) {
      const resolved = await source.resolveProjectId(flags.project);
      opts.projectId = resolved.projectId;
    }

    const sessions = await source.getSessions(opts);

    // Empty state
    if (sessions.length === 0) {
      const periodLabel = formatPeriodLabel(flags.period);
      console.log(sectionHeader('COST BREAKDOWN', periodLabel));
      console.log(`\n  No sessions found in the ${periodLabel.toLowerCase()}.\n`);
      console.log(colors.hint('Run stats --period 30d to expand the time range'));
      console.log();
      return;
    }

    const config = loadConfig();
    const plans = getEffectivePlans(config);
    const cost = computeCostBreakdown(sessions, flags.period, plans);
    const periodLabel = formatPeriodLabel(flags.period);

    // No cost data at all
    if (cost.sessionsWithCostCount === 0) {
      console.log(sectionHeader('COST BREAKDOWN', periodLabel));
      console.log(`\n  No cost data available.\n`);
      console.log(`  Cost tracking is supported by:`);
      console.log(`    ${colors.success('\u25CF')} Claude Code (automatic)`);
      console.log(`    ${colors.success('\u25CF')} Cursor (via usage export)`);
      console.log();
      console.log(colors.hint('Run code-insights sync to refresh data'));
      console.log();
      return;
    }

    // Header
    console.log(sectionHeader('COST BREAKDOWN', periodLabel));

    // Cost data coverage warning
    if (cost.sessionsWithCostCount < cost.sessionCount * 0.5) {
      console.log(`\n  ${colors.warning(`\u26A0 ${cost.sessionCount - cost.sessionsWithCostCount} sessions have no cost data`)}`);
    }

    // Metric grid
    console.log();
    const hasSubscriptions = cost.plans.some(p => p.type === 'subscription' && p.sessionCount > 0);
    if (hasSubscriptions) {
      console.log(metricGrid([
        { label: 'Actual Spend', value: formatMoney(cost.actualCost) },
        { label: 'API Value', value: formatMoney(cost.totalCost) },
        { label: 'Plan Savings', value: `${formatMoney(cost.totalSavings)} (${formatPercent(cost.planSavingsPercent)})` },
        { label: 'Sessions', value: `${cost.sessionCount} (${cost.sessionsWithCostCount} with cost data)` },
      ]));
    } else {
      console.log(metricGrid([
        { label: 'Total', value: formatMoney(cost.totalCost) },
        { label: 'Avg/day', value: formatMoney(cost.avgPerDay) },
        { label: 'Avg/session', value: formatMoney(cost.avgPerSession) },
        { label: 'Sessions', value: `${cost.sessionCount} (${cost.sessionsWithCostCount} with cost data)` },
      ]));
    }

    // Plan vs Pay-As-You-Go API comparison
    const activePlans = cost.plans.filter(p => p.sessionCount > 0);
    if (activePlans.length > 0) {
      console.log(sectionHeader('PLAN VS PAY-AS-YOU-GO COMPARISON'));
      for (const p of activePlans) {
        const typeBadge = p.type === 'subscription'
          ? colors.success(`[Plan: $${(p.monthlyFee ?? 0).toFixed(2)}/mo]`)
          : p.type === 'free'
          ? colors.label('[Free / Local]')
          : colors.warning('[Pay-As-You-Go]');
        const spendStr = `${colors.label('Your Spend:')} ${colors.money(p.periodCost)}`;
        const valStr = `${colors.label('Pay-As-You-Go API:')} ${colors.money(p.tokenValue)}`;
        const planRoi = p.periodCost > 0 ? (p.tokenValue / p.periodCost).toFixed(1) + 'x ROI' : '';
        const saveStr = p.savings > 0 ? ` ${colors.success(`(Saved ${formatMoney(p.savings)}${planRoi ? `, ${planRoi}` : ''})`)}` : '';
        const sessStr = colors.label(`(${p.sessionCount} sessions)`);
        console.log(`  ${colors.value(p.planName)} ${typeBadge}`);
        console.log(`    ${spendStr}    ${valStr}${saveStr}    ${sessStr}`);
      }
    }

    // Daily trend sparkline
    const spark = sparkline(cost.dailyTrend.map(d => d.value));
    const labels = sparklineLabels(flags.period);
    console.log(sectionHeader('DAILY TREND', spark));
    if (labels) {
      console.log(`  ${colors.label(labels)}`);
    }
    if (cost.peakDay) {
      console.log(`  ${colors.label('Peak:')} ${colors.value(cost.peakDay.date)} ${colors.money(cost.peakDay.cost)} ${colors.label(`(${cost.peakDay.sessions} sessions)`)}`);
    }

    // By project
    if (cost.byProject.length > 0) {
      console.log(sectionHeader('BY PROJECT'));
      const barWidth = getBarWidth();
      const lines = barChart(
        cost.byProject.map(p => ({
          label: p.name,
          value: p.cost,
          suffix: `${colors.money(p.cost)}   ${formatPercent(p.percent)}   ${colors.label(`${p.count} sessions`)}`,
        })),
        barWidth,
      );
      for (const line of lines) {
        console.log(line);
      }
    }

    // By model
    if (cost.byModel.length > 0) {
      console.log(sectionHeader('BY MODEL'));
      const barWidth = getBarWidth();
      const lines = barChart(
        cost.byModel.map(m => ({
          label: m.name,
          value: m.cost,
          suffix: `${colors.money(m.cost)}   ${formatPercent(m.percent)}   ${colors.label(`${m.count} sessions`)}`,
        })),
        barWidth,
      );
      for (const line of lines) {
        console.log(line);
      }
    }

    // Token breakdown
    const tb = cost.tokenBreakdown;
    if (tb.inputTokens + tb.outputTokens > 0) {
      console.log(sectionHeader('TOKEN BREAKDOWN'));
      const barWidth = getBarWidth();
      const tokenItems = [
        { label: 'Input tokens', value: tb.inputCost, suffix: `${formatTokens(tb.inputTokens)}   ${colors.money(tb.inputCost)}` },
        { label: 'Output tokens', value: tb.outputCost, suffix: `${formatTokens(tb.outputTokens)}   ${colors.money(tb.outputCost)}` },
        { label: 'Cache creation', value: tb.cacheCreationCost, suffix: `${formatTokens(tb.cacheCreation)}   ${colors.money(tb.cacheCreationCost)}` },
        { label: 'Cache reads', value: tb.cacheReadCost, suffix: `${formatTokens(tb.cacheReads)}   ${colors.money(tb.cacheReadCost)}` },
      ];
      const lines = barChart(tokenItems, barWidth);
      for (const line of lines) {
        console.log(line);
      }
      console.log(`  ${colors.label('Cache hit rate')}     ${formatPercent(tb.cacheHitRate * 100)}`);
    }

    // Hints
    console.log();
    console.log(colors.hint(`Run stats cost --period 30d for monthly trends`));
    console.log(colors.hint('Run stats models for detailed model analysis'));
    console.log();
    trackEvent('cli_stats', { duration_ms: Date.now() - startTime, subcommand: 'cost', period: flags.period, source_filter: flags.source ?? null, success: true });
    showTip('stats cost');
  } catch (err) {
    trackEvent('cli_stats', { duration_ms: Date.now() - startTime, subcommand: 'cost', period: flags.period, source_filter: flags.source ?? null, success: false });
    handleStatsError(err);
  }
}
