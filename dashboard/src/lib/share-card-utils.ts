// Utilities for the shareable working style card.
// Canvas 2D implementation — no external dependencies, pixel-perfect text rendering.

// Keep in sync with SOURCE_LABELS in dashboard/src/components/sessions/CompactSessionRow.tsx
export const SOURCE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'cursor': 'Cursor',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  'copilot': 'VS Code Copilot',
};

export interface ToolPillColors {
  bg: string;
  text: string;
  border: string;
}

export const SOURCE_TOOL_PILL_COLORS: Record<string, ToolPillColors> = {
  'claude-code': { bg: '#2a1f16', text: '#fb923c', border: 'rgba(251,146,60,0.3)' },
  'cursor':      { bg: '#161d2e', text: '#60a5fa', border: 'rgba(96,165,250,0.3)' },
  'codex-cli':   { bg: '#142319', text: '#4ade80', border: 'rgba(74,222,128,0.3)' },
  'copilot-cli': { bg: '#0f2027', text: '#22d3ee', border: 'rgba(34,211,238,0.3)' },
  'copilot':     { bg: '#1c172e', text: '#a78bfa', border: 'rgba(167,139,250,0.3)' },
};

export interface MilestonePill {
  icon: string;
  label: string;
  iconColor: string;
}

/**
 * Compute milestone pills from session stats.
 * Returns at most 4 pills, priority-ordered.
 */
export function computeMilestones(
  totalSessions: number,
  streak: number,
  sourceToolCount: number,
  successRate: number
): MilestonePill[] {
  const milestones: MilestonePill[] = [];

  const sessionThresholds = [1000, 500, 250, 100, 50] as const;
  for (const t of sessionThresholds) {
    if (totalSessions >= t) {
      milestones.push({ icon: '★', label: `${t}+ Sessions`, iconColor: '#c084fc' });
      break;
    }
  }

  const streakThresholds = [90, 60, 30, 14, 7] as const;
  for (const t of streakThresholds) {
    if (streak >= t) {
      milestones.push({ icon: '🔥', label: `${t}-Day Streak`, iconColor: '#f59e0b' });
      break;
    }
  }

  if (sourceToolCount >= 5) {
    milestones.push({ icon: '⚡', label: '5 AI Tools', iconColor: '#22d3ee' });
  } else if (sourceToolCount >= 4) {
    milestones.push({ icon: '⚡', label: '4 AI Tools', iconColor: '#22d3ee' });
  } else if (sourceToolCount >= 3) {
    milestones.push({ icon: '⚡', label: '3+ AI Tools', iconColor: '#22d3ee' });
  } else if (sourceToolCount >= 2) {
    milestones.push({ icon: '⚡', label: '2+ AI Tools', iconColor: '#22d3ee' });
  }

  if (successRate > 85 && totalSessions >= 30) {
    milestones.push({ icon: '✓', label: '85%+ Success', iconColor: '#4ade80' });
  }

  return milestones.slice(0, 4);
}

// Character type colors — match SESSION_CHARACTER_COLORS hues
const CHARACTER_COLORS: Record<string, string> = {
  deep_focus:    '#6366f1',
  bug_hunt:      '#ef4444',
  feature_build: '#10b981',
  exploration:   '#f59e0b',
  refactor:      '#06b6d4',
  learning:      '#8b5cf6',
  quick_task:    '#64748b',
};

// Keep in sync with SESSION_CHARACTER_LABELS in dashboard/src/lib/constants/colors.ts
const CHARACTER_LABELS: Record<string, string> = {
  deep_focus:    'Deep Focus',
  bug_hunt:      'Bug Hunt',
  feature_build: 'Feature Build',
  exploration:   'Exploration',
  refactor:      'Refactor',
  learning:      'Learning',
  quick_task:    'Quick Task',
};

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function abbreviateCount(n: number): string {
  if (n >= 10000) return `${Math.floor(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Truncate text to fit within maxWidth, appending ellipsis if needed. */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '\u2026').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '\u2026';
}

/** Draw the app logo (blue rounded rect + white lines) at (x, y) with given size. */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const rx = size * 0.25;
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, rx);
  ctx.fill();

  ctx.strokeStyle = 'white';
  ctx.lineWidth = size * 0.13;
  ctx.lineCap = 'round';
  const pad = size * 0.28;

  ctx.beginPath();
  ctx.moveTo(x + pad, y + size * 0.36);
  ctx.lineTo(x + size - pad, y + size * 0.36);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + pad, y + size * 0.50);
  ctx.lineTo(x + size - pad * 1.5, y + size * 0.50);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + pad, y + size * 0.64);
  ctx.lineTo(x + size - pad * 0.8, y + size * 0.64);
  ctx.stroke();
}

/**
 * Derive month + year label from an ISO week string (e.g. "2026-W11" to "Mar 2026").
 * Uses the Monday of that ISO week to avoid wrong month for historical weeks.
 */
function getMonthYearFromWeek(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) {
    return new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay();
  const daysToMonday = jan4Day === 0 ? 6 : jan4Day - 1;
  const week1Monday = new Date(jan4.getTime() - daysToMonday * 86400000);
  const weekMonday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  return weekMonday.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface ShareCardProps {
  tagline: string;
  taglineSubtitle?: string;
  totalSessions: number;
  streak: number;
  sourceTools: string[];
  characterDistribution: Record<string, number>;
  outcomeDistribution: Record<string, number>;
  currentWeek: string;
}

/**
 * Draw the full share card onto the given canvas at 1200x630px.
 * The canvas must already have width=1200 and height=630 set.
 */
export function drawShareCard(canvas: HTMLCanvasElement, props: ShareCardProps): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = 1200;
  const H = 630;
  const PAD = 48;

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0f0f23');
  bg.addColorStop(1, '#1a1a3e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Radial glow top-left (blue)
  const glow1 = ctx.createRadialGradient(-60, -60, 0, -60, -60, 380);
  glow1.addColorStop(0, 'rgba(59,130,246,0.18)');
  glow1.addColorStop(1, 'rgba(59,130,246,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  // Radial glow bottom-right (violet)
  const glow2 = ctx.createRadialGradient(W + 80, H + 80, 0, W + 80, H + 80, 500);
  glow2.addColorStop(0, 'rgba(168,85,247,0.14)');
  glow2.addColorStop(1, 'rgba(168,85,247,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Header: Logo + "CODE INSIGHTS"
  const LOGO_SIZE = 28;
  drawLogo(ctx, PAD, PAD, LOGO_SIZE);

  ctx.font = `600 13px ${FONT_STACK}`;
  ctx.fillStyle = '#a0a0b8';
  ctx.letterSpacing = '2px';
  ctx.fillText('CODE INSIGHTS', PAD + LOGO_SIZE + 10, PAD + LOGO_SIZE * 0.72);
  ctx.letterSpacing = '0px';

  // Tool pills (top-right, right-aligned)
  const tools = props.sourceTools.slice(0, 4);
  const PILL_H = 24;
  const PILL_PAD_X = 12;
  ctx.font = `500 12px ${FONT_STACK}`;

  let pillX = W - PAD;
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    const colors = SOURCE_TOOL_PILL_COLORS[tool] ?? { bg: '#1e293b', text: '#94a3b8', border: 'rgba(148,163,184,0.3)' };
    const label = SOURCE_TOOL_DISPLAY_NAMES[tool] ?? tool;
    const textW = ctx.measureText(label).width;
    const pillW = textW + PILL_PAD_X * 2;
    pillX -= pillW;

    ctx.fillStyle = colors.bg;
    ctx.beginPath();
    ctx.roundRect(pillX, PAD, pillW, PILL_H, PILL_H / 2);
    ctx.fill();

    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pillX, PAD, pillW, PILL_H, PILL_H / 2);
    ctx.stroke();

    ctx.fillStyle = colors.text;
    ctx.fillText(label, pillX + PILL_PAD_X, PAD + PILL_H * 0.68);

    pillX -= 8;
  }

  // Tagline
  const TAGLINE_Y = PAD + LOGO_SIZE + 52;
  ctx.font = `bold 44px ${FONT_STACK}`;
  ctx.fillStyle = '#a78bfa';
  ctx.fillText(truncateText(ctx, props.tagline, W - PAD * 2), PAD, TAGLINE_Y);

  // Tagline subtitle
  let subtitleBottomY = TAGLINE_Y + 10;
  if (props.taglineSubtitle) {
    const SUBTITLE_Y = TAGLINE_Y + 36;
    ctx.font = `400 22px ${FONT_STACK}`;
    ctx.fillStyle = '#8b8ba0';
    ctx.fillText(truncateText(ctx, props.taglineSubtitle, W - PAD * 2), PAD, SUBTITLE_Y);
    subtitleBottomY = SUBTITLE_Y + 10;
  }

  // Stat boxes
  const outcomeTotal = Object.values(props.outcomeDistribution).reduce((s, v) => s + v, 0);
  const successCount = props.outcomeDistribution['high'] ?? 0;
  const successRate = outcomeTotal > 0 ? Math.round((successCount / outcomeTotal) * 100) : 0;

  const STAT_TOP = subtitleBottomY + 36;
  const STAT_BOX_W = 160;
  const STAT_BOX_H = 88;
  const STAT_GAP = 16;
  const STAT_RADIUS = 8;

  const stats = [
    { value: abbreviateCount(props.totalSessions), label: 'SESSIONS' },
    { value: props.streak > 0 ? `${props.streak}d` : '\u2014', label: 'STREAK' },
    { value: outcomeTotal > 0 ? `${successRate}%` : '\u2014', label: 'SUCCESS' },
  ];

  for (let i = 0; i < stats.length; i++) {
    const bx = PAD + i * (STAT_BOX_W + STAT_GAP);
    const by = STAT_TOP;

    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.roundRect(bx, by, STAT_BOX_W, STAT_BOX_H, STAT_RADIUS);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, STAT_BOX_W, STAT_BOX_H, STAT_RADIUS);
    ctx.stroke();

    ctx.font = `bold 44px ${FONT_STACK}`;
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'center';
    ctx.fillText(stats[i].value, bx + STAT_BOX_W / 2, by + 52);

    ctx.font = `600 14px ${FONT_STACK}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(stats[i].label, bx + STAT_BOX_W / 2, by + 72);
    ctx.textAlign = 'left';
  }

  // Character distribution legend
  const LEGEND_TOP = STAT_TOP + STAT_BOX_H + 32;
  const sortedChars = Object.entries(props.characterDistribution)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const charTotal = sortedChars.reduce((s, [, v]) => s + v, 0);

  if (sortedChars.length > 0) {
    ctx.font = `400 20px ${FONT_STACK}`;
    let legendX = PAD;
    const DOT_R = 6;
    const LEGEND_GAP = 28;

    for (const [key, count] of sortedChars) {
      const pct = charTotal > 0 ? Math.round((count / charTotal) * 100) : 0;
      const label = `${CHARACTER_LABELS[key] ?? key} ${pct}%`;
      const color = CHARACTER_COLORS[key] ?? '#64748b';

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(legendX + DOT_R, LEGEND_TOP - 5, DOT_R, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(label, legendX + DOT_R * 2 + 8, LEGEND_TOP);
      legendX += ctx.measureText(label).width + DOT_R * 2 + 8 + LEGEND_GAP;
    }
  }

  // Milestone pills
  const milestones = computeMilestones(props.totalSessions, props.streak, props.sourceTools.length, successRate);
  if (milestones.length > 0) {
    const MILESTONE_TOP = LEGEND_TOP + 44;
    ctx.font = `400 18px ${FONT_STACK}`;
    let mx = PAD;
    const M_PAD = 14;
    const M_PILL_H = 28;

    for (const m of milestones) {
      const iconW = ctx.measureText(m.icon).width;
      const labelW = ctx.measureText(m.label).width;
      const pillW = iconW + labelW + M_PAD * 2 + 8;
      const pillTop = MILESTONE_TOP - M_PILL_H * 0.72;

      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.roundRect(mx, pillTop, pillW, M_PILL_H, M_PILL_H / 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mx, pillTop, pillW, M_PILL_H, M_PILL_H / 2);
      ctx.stroke();

      ctx.fillStyle = m.iconColor;
      ctx.fillText(m.icon, mx + M_PAD, MILESTONE_TOP);

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(m.label, mx + M_PAD + iconW + 8, MILESTONE_TOP);

      mx += pillW + 10;
    }
  }

  // Divider
  const FOOTER_TOP = H - 90;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, FOOTER_TOP);
  ctx.lineTo(W - PAD, FOOTER_TOP);
  ctx.stroke();

  // Footer
  const FOOTER_LOGO_SIZE = 20;
  const FOOTER_Y = FOOTER_TOP + 36;
  drawLogo(ctx, PAD, FOOTER_TOP + 12, FOOTER_LOGO_SIZE);

  ctx.font = `400 16px ${FONT_STACK}`;
  ctx.fillStyle = '#64748b';
  ctx.fillText('code-insights.app', PAD + FOOTER_LOGO_SIZE + 10, FOOTER_Y);

  ctx.font = `400 14px ${FONT_STACK}`;
  ctx.fillStyle = '#475569';
  ctx.fillText('Analyze your AI coding sessions', PAD, FOOTER_Y + 22);

  const monthYear = getMonthYearFromWeek(props.currentWeek);
  const footerRight = `Patterns \u00b7 ${monthYear}`;
  const footerRightW = ctx.measureText(footerRight).width;
  ctx.fillText(footerRight, W - PAD - footerRightW, FOOTER_Y);
}

/**
 * Create an ephemeral canvas, draw the share card, and trigger a PNG download.
 * No DOM element ref needed — canvas is created and discarded in memory.
 */
export async function downloadShareCard(props: ShareCardProps): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  drawShareCard(canvas, props);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png')
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'code-insights-working-style.png';
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}
