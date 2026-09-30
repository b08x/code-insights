import chalk from 'chalk';
import type { AnalysisResponse, PromptQualityResponse } from '../analysis/prompt-types.js';
import { PATTERN_CATEGORY_LABELS } from '../analysis/pattern-normalize.js';
import { PQ_CATEGORY_LABELS } from '../analysis/prompt-quality-normalize.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const EMOJI = {
  success: '\u2705',
  partial: '\u26A0\uFE0F',
  blocked: '\u274C',
  abandoned: '\u23F8\uFE0F',
  high: '\u{1F534}',
  medium: '\u{1F7E1}',
  low: '\u{1F7E2}',
  decision: '\u{1F3AF}',
  learning: '\u{1F4A1}',
  friction: '\u{1F525}',
  pattern: '\u2728',
  deficit: '\u2796',
  strength: '\u2795',
  pq: '\u{1F4CA}',
  summary: '\u{1F4DD}',
  metric: '\u2699\uFE0F',
  time: '\u23F1\uFE0F',
};

function outcomeEmoji(outcome?: string): string {
  switch (outcome) {
    case 'success': return EMOJI.success;
    case 'partial': return EMOJI.partial;
    case 'blocked': return EMOJI.blocked;
    case 'abandoned': return EMOJI.abandoned;
    default: return '\u2753';
  }
}

function severityColor(severity: string): (s: string) => string {
  switch (severity) {
    case 'high': return chalk.red;
    case 'medium': return chalk.yellow;
    case 'low': return chalk.green;
    default: return chalk.dim;
  }
}

function severityDot(severity: string): string {
  const color = severityColor(severity);
  const emoji = severity === 'high' ? EMOJI.high : severity === 'medium' ? EMOJI.medium : EMOJI.low;
  return `${color(emoji)} ${color(severity)}`;
}

function scoreColor(score: number): (s: string) => string {
  if (score >= 80) return chalk.green;
  if (score >= 60) return chalk.yellow;
  return chalk.red;
}

function scoreBar(score: number, width: number = 20): string {
  const filled = Math.round((score / 100) * width);
  const color = scoreColor(score);
  const filledBar = color('\u2588'.repeat(filled));
  const emptyBar = chalk.dim('\u2591'.repeat(width - filled));
  return `${filledBar}${emptyBar}`;
}

function indent(text: string, spaces: number = 2): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => `${pad}${line}`).join('\n');
}

function sectionHeader(icon: string, title: string): string {
  return `\n${icon}  ${chalk.bold.cyan(title)}`;
}

function divider(): string {
  return chalk.dim('\u2500'.repeat(60));
}

// ── Main Renderer ───────────────────────────────────────────────────────────

export interface RenderContext {
  sessionAnalysis: AnalysisResponse;
  /** Absent when the prompt-quality pass was skipped (fewer than 2 human messages). */
  pqAnalysis?: PromptQualityResponse;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  messageCount?: number;
  projectName?: string;
}

export function renderAnalysisReport(ctx: RenderContext): string {
  const lines: string[] = [];
  const { sessionAnalysis, pqAnalysis } = ctx;

  // ── Header ──────────────────────────────────────────────────────────────

  const title = sessionAnalysis.summary?.title || 'Session Analysis';
  const outcome = sessionAnalysis.summary?.outcome;

  lines.push('');
  lines.push(divider());
  lines.push(`${chalk.bold.white(title)}  ${outcomeEmoji(outcome)} ${chalk.dim(outcome || 'unknown')}`);
  lines.push(divider());

  // ── Summary ──────────────────────────────────────────────────────────────

  if (sessionAnalysis.summary?.content) {
    lines.push(sectionHeader(EMOJI.summary, 'Summary'));
    lines.push(indent(chalk.white(sessionAnalysis.summary.content)));

    if (sessionAnalysis.summary.bullets?.length) {
      lines.push('');
      for (const bullet of sessionAnalysis.summary.bullets) {
        lines.push(indent(`${chalk.cyan('\u2022')} ${chalk.white(bullet)}`));
      }
    }
  }

  // ── Prompt Quality Score ─────────────────────────────────────────────────

  if (pqAnalysis) {
    lines.push(sectionHeader(EMOJI.pq, 'Prompt Quality'));
    const pqColor = scoreColor(pqAnalysis.efficiency_score);
    lines.push(indent(`${pqColor(pqAnalysis.efficiency_score + '/100')}  ${scoreBar(pqAnalysis.efficiency_score)}`));

    if (pqAnalysis.assessment) {
      lines.push(indent(chalk.dim(pqAnalysis.assessment)));
    }

    // Dimension scores
    if (pqAnalysis.dimension_scores) {
      lines.push('');
      const dims = pqAnalysis.dimension_scores;
      const dimEntries: [string, number][] = [
        ['Context', dims.context_provision],
        ['Specificity', dims.request_specificity],
        ['Scope', dims.scope_management],
        ['Timing', dims.information_timing],
        ['Correction', dims.correction_quality],
      ];
      for (const [label, score] of dimEntries) {
        const c = scoreColor(score);
        lines.push(indent(`  ${chalk.dim(label.padEnd(12))} ${c(String(score).padStart(3))}  ${scoreBar(score, 15)}`));
      }
    }
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  if (sessionAnalysis.decisions?.length) {
    lines.push(sectionHeader(EMOJI.decision, `Decisions (${sessionAnalysis.decisions.length})`));
    for (const d of sessionAnalysis.decisions) {
      const conf = d.confidence != null ? chalk.dim(` [${d.confidence}%]`) : '';
      lines.push(indent(`${chalk.bold.white(d.title)}${conf}`));
      if (d.reasoning) {
        lines.push(indent(chalk.dim(`  ${d.reasoning.slice(0, 120)}${d.reasoning.length > 120 ? '...' : ''}`)));
      }
      if (d.trade_offs) {
        lines.push(indent(chalk.dim(`  Trade-offs: ${d.trade_offs}`)));
      }
      lines.push('');
    }
  }

  // ── Learnings ────────────────────────────────────────────────────────────

  if (sessionAnalysis.learnings?.length) {
    lines.push(sectionHeader(EMOJI.learning, `Learnings (${sessionAnalysis.learnings.length})`));
    for (const l of sessionAnalysis.learnings) {
      const conf = l.confidence != null ? chalk.dim(` [${l.confidence}%]`) : '';
      lines.push(indent(`${chalk.bold.white(l.title)}${conf}`));
      if (l.takeaway) {
        lines.push(indent(chalk.dim(`  ${l.takeaway}`)));
      }
      lines.push('');
    }
  }

  // ── Friction Points ──────────────────────────────────────────────────────

  const frictionPoints = sessionAnalysis.facets?.friction_points;
  if (frictionPoints?.length) {
    lines.push(sectionHeader(EMOJI.friction, `Friction Points (${frictionPoints.length})`));
    for (const f of frictionPoints) {
      lines.push(indent(`${severityDot(f.severity)}  ${chalk.bold.white(f.description)}`));
      const meta: string[] = [];
      if (f.category) meta.push(chalk.dim(f.category));
      if (f.attribution) meta.push(chalk.dim(f.attribution));
      if (meta.length) lines.push(indent(`    ${meta.join(' \u00B7 ')}`));
      if (f.resolution) {
        lines.push(indent(chalk.dim(`    Resolution: ${f.resolution}`)));
      }
      lines.push('');
    }
  }

  // ── Effective Patterns ───────────────────────────────────────────────────

  const patterns = sessionAnalysis.facets?.effective_patterns;
  if (patterns?.length) {
    lines.push(sectionHeader(EMOJI.pattern, `Effective Patterns (${patterns.length})`));
    for (const p of patterns) {
      const label = PATTERN_CATEGORY_LABELS[p.category] || p.category;
      const conf = scoreColor(p.confidence)(`${p.confidence}%`);
      lines.push(indent(`${EMOJI.pattern}  ${chalk.bold.white(label)}  ${conf}`));
      if (p.description) {
        lines.push(indent(chalk.dim(`  ${p.description}`)));
      }
      if (p.driver) {
        lines.push(indent(chalk.dim(`  Driver: ${p.driver}`)));
      }
      lines.push('');
    }
  }

  // ── Course Correction ────────────────────────────────────────────────────

  if (sessionAnalysis.facets?.had_course_correction) {
    lines.push(sectionHeader('\u{1F504}', 'Course Correction'));
    if (sessionAnalysis.facets.course_correction_reason) {
      lines.push(indent(chalk.yellow(sessionAnalysis.facets.course_correction_reason)));
    }
    if (sessionAnalysis.facets.iteration_count) {
      lines.push(indent(chalk.dim(`Iterations: ${sessionAnalysis.facets.iteration_count}`)));
    }
    lines.push('');
  }

  // ── PQ Findings ──────────────────────────────────────────────────────────

  if (pqAnalysis?.findings?.length) {
    const deficits = pqAnalysis.findings.filter(f => f.type === 'deficit');
    const strengths = pqAnalysis.findings.filter(f => f.type === 'strength');

    if (deficits.length) {
      lines.push(sectionHeader(EMOJI.deficit, `Prompt Deficits (${deficits.length})`));
      for (const f of deficits) {
        const label = PQ_CATEGORY_LABELS[f.category] || f.category;
        const impact = severityDot(f.impact);
        lines.push(indent(`${impact}  ${chalk.bold.white(label)}`));
        lines.push(indent(chalk.dim(`  ${f.description}`)));
        if (f.suggested_improvement) {
          lines.push(indent(chalk.cyan(`  Suggestion: ${f.suggested_improvement}`)));
        }
        lines.push('');
      }
    }

    if (strengths.length) {
      lines.push(sectionHeader(EMOJI.strength, `Prompt Strengths (${strengths.length})`));
      for (const f of strengths) {
        const label = PQ_CATEGORY_LABELS[f.category] || f.category;
        lines.push(indent(`${EMOJI.strength}  ${chalk.bold.white(label)}`));
        lines.push(indent(chalk.dim(`  ${f.description}`)));
        lines.push('');
      }
    }
  }

  // ── PQ Takeaways ─────────────────────────────────────────────────────────

  if (pqAnalysis?.takeaways?.length) {
    lines.push(sectionHeader('\u{1F3AF}', 'Prompt Takeaways'));
    for (const t of pqAnalysis.takeaways) {
      const icon = t.type === 'improve' ? '\u{1F4DD}' : '\u2705';
      const label = PQ_CATEGORY_LABELS[t.category] || t.category;
      lines.push(indent(`${icon}  ${chalk.bold.white(label)}  ${chalk.dim(t.type)}`));
      if (t.type === 'improve' && t.better_prompt) {
        lines.push(indent(chalk.cyan(`  Better: "${t.better_prompt}"`)));
        if (t.why) lines.push(indent(chalk.dim(`  Why: ${t.why}`)));
      }
      if (t.type === 'reinforce' && t.what_worked) {
        lines.push(indent(chalk.green(`  Worked: ${t.what_worked}`)));
        if (t.why_effective) lines.push(indent(chalk.dim(`  Why: ${t.why_effective}`)));
      }
      lines.push('');
    }
  }

  // ── Metrics Footer ───────────────────────────────────────────────────────

  lines.push(divider());
  const metrics: string[] = [];

  if (ctx.messageCount) {
    metrics.push(`${EMOJI.metric} ${ctx.messageCount} messages`);
  }
  if (ctx.durationMs) {
    const secs = (ctx.durationMs / 1000).toFixed(1);
    metrics.push(`${EMOJI.time} ${secs}s`);
  }
  if (ctx.inputTokens || ctx.outputTokens) {
    metrics.push(`\u{1F4E6} ${ctx.inputTokens || 0}\u2192${ctx.outputTokens || 0} tokens`);
  }
  if (ctx.model) {
    metrics.push(`${chalk.dim(ctx.model)}`);
  }
  if (ctx.projectName) {
    metrics.push(`${chalk.dim(ctx.projectName)}`);
  }

  lines.push(indent(metrics.join('  \u00B7  ')));
  lines.push(divider());
  lines.push('');

  return lines.join('\n');
}
