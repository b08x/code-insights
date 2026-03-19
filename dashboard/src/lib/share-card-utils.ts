// Utilities for the shareable AI Fluency Score card.
// Canvas 2D implementation — no external dependencies, pixel-perfect text rendering.
// V3: Score card + fingerprint — single hero score, 5 rainbow bars, evidence lines.

import type { PQDimensionScores } from '@/lib/api';
import {
  drawIcon, drawToolIcon, loadToolIcons, deduplicateToolsForIcons,
  ICON_BOOK_OPEN, ICON_TARGET, ICON_EYE, ICON_CLOCK, ICON_GIT_BRANCH,
  ICON_BAR_CHART_3, ICON_ZAP,
} from '@/lib/share-card-icons';

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface ShareCardProps {
  tagline: string;
  dimensionScores: PQDimensionScores | null; // null = no PQ data
  totalSessions: number;       // sessions in 4-week scoring window
  totalTokens: number;         // tokens in 4-week scoring window
  lifetimeSessions: number;    // all-time session count
  sourceTools: string[];
  currentWeek: string;         // for month/year in header
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
 * Derive month + year label from an ISO week string (e.g. "2026-W11" → "Mar 2026").
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

/** Format token count: 1,200,000 → "1.2M tokens", 850,000 → "850K tokens", 12,000 → "12K tokens". */
function abbreviateTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K tokens`;
  return `${n} tokens`;
}

/** Score color tiers — arc gradient start/end and number color. */
function scoreColors(score: number | null): { numberColor: string; arcStart: string; arcEnd: string } {
  if (score === null) return { numberColor: '#64748b', arcStart: '#64748b', arcEnd: '#475569' };
  if (score >= 80) return { numberColor: '#f1f5f9', arcStart: '#a78bfa', arcEnd: '#818cf8' };
  if (score >= 60) return { numberColor: '#e2e8f0', arcStart: '#a78bfa', arcEnd: '#818cf8' };
  if (score >= 40) return { numberColor: '#cbd5e1', arcStart: '#f59e0b', arcEnd: '#eab308' };
  return { numberColor: '#94a3b8', arcStart: '#64748b', arcEnd: '#475569' };
}

// Fingerprint bar definitions — order matches V3 spec
const FINGERPRINT_BARS = [
  { label: 'CONTEXT',       field: 'context_provision',   color: '#60a5fa', icon: ICON_BOOK_OPEN,   yCentre: 252 },
  { label: 'CLARITY',       field: 'request_specificity', color: '#a78bfa', icon: ICON_TARGET,      yCentre: 284 },
  { label: 'FOCUS',         field: 'scope_management',    color: '#34d399', icon: ICON_EYE,         yCentre: 316 },
  { label: 'TIMING',        field: 'information_timing',  color: '#fbbf24', icon: ICON_CLOCK,       yCentre: 348 },
  { label: 'ORCHESTRATION', field: 'correction_quality',  color: '#f472b6', icon: ICON_GIT_BRANCH,  yCentre: 380 },
] as const;

/**
 * Draw the full share card onto the given canvas at 1200×630px.
 * The canvas must already have width=1200 and height=630 set.
 * V3: Score card + fingerprint layout.
 * toolIcons pre-loaded via loadToolIcons() for async image rendering.
 */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  props: ShareCardProps,
  toolIcons: Map<string, HTMLImageElement>
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = 1200;
  const H = 630;
  const PAD = 48;
  const CONTENT_W = W - PAD * 2; // 1104

  // ── Background ──────────────────────────────────────────────────────────────

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0c0c18');
  bg.addColorStop(1, '#141428');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow1 = ctx.createRadialGradient(-60, -60, 0, -60, -60, 400);
  glow1.addColorStop(0, 'rgba(99,102,241,0.12)');
  glow1.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(1260, 690, 0, 1260, 690, 500);
  glow2.addColorStop(0, 'rgba(168,85,247,0.10)');
  glow2.addColorStop(1, 'rgba(168,85,247,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  const glow3 = ctx.createRadialGradient(240, 320, 0, 240, 320, 200);
  glow3.addColorStop(0, 'rgba(167,139,250,0.08)');
  glow3.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = glow3;
  ctx.fillRect(0, 0, W, H);

  // ── Section 1: Header (y=48) ─────────────────────────────────────────────────

  const LOGO_SIZE = 28;
  drawLogo(ctx, PAD, PAD, LOGO_SIZE);

  ctx.font = `600 13px ${FONT_STACK}`;
  ctx.fillStyle = '#64748b';
  ctx.letterSpacing = '2px';
  ctx.fillText('CODE INSIGHTS', PAD + LOGO_SIZE + 10, PAD + LOGO_SIZE * 0.72);
  ctx.letterSpacing = '0px';

  const monthYear = getMonthYearFromWeek(props.currentWeek);
  ctx.font = `500 14px ${FONT_STACK}`;
  ctx.fillStyle = '#475569';
  ctx.textAlign = 'right';
  ctx.fillText(monthYear, W - PAD, PAD + LOGO_SIZE * 0.72);
  ctx.textAlign = 'left';

  // ── Section 2: Archetype Identity (y=138) ────────────────────────────────────

  const displayTagline = props.tagline || 'AI Coding Profile';
  ctx.font = `700 40px ${FONT_STACK}`;
  ctx.fillStyle = '#e2e0ff';
  ctx.fillText(truncateText(ctx, displayTagline, CONTENT_W), PAD, 138);

  // ── Section 3: Hero Score Circle (center at x=200, y=320) ────────────────────

  const SCORE_CX = 200;
  const SCORE_CY = 320;
  const SCORE_R = 90;
  const score = props.dimensionScores?.overall ?? null;
  const colors = scoreColors(score);

  // Hero watermark — app logo drawn large at very low opacity, centered behind score
  ctx.globalAlpha = 0.04;
  const WATERMARK_SIZE = 160;
  drawLogo(ctx, SCORE_CX - WATERMARK_SIZE / 2, SCORE_CY - WATERMARK_SIZE / 2, WATERMARK_SIZE);
  ctx.globalAlpha = 1.0;

  // Track ring (full circle background)
  ctx.beginPath();
  ctx.arc(SCORE_CX, SCORE_CY, SCORE_R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 8;
  ctx.stroke();

  // Score arc (filled portion)
  if (score !== null && score > 0) {
    const arcGradient = ctx.createLinearGradient(
      SCORE_CX - SCORE_R, SCORE_CY,
      SCORE_CX + SCORE_R, SCORE_CY
    );
    arcGradient.addColorStop(0, colors.arcStart);
    arcGradient.addColorStop(1, colors.arcEnd);

    const startAngle = -Math.PI / 2; // 12 o'clock
    const endAngle = startAngle + (score / 100) * Math.PI * 2;

    ctx.beginPath();
    ctx.arc(SCORE_CX, SCORE_CY, SCORE_R, startAngle, endAngle);
    ctx.strokeStyle = arcGradient;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Score number
  ctx.textAlign = 'center';
  if (score !== null) {
    ctx.font = `700 72px ${FONT_STACK}`;
    ctx.fillStyle = colors.numberColor;
    ctx.fillText(String(score), SCORE_CX, 316);
  } else {
    ctx.font = `700 64px ${FONT_STACK}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText('—', SCORE_CX, 316);
  }

  ctx.font = `600 13px ${FONT_STACK}`;
  ctx.fillStyle = '#64748b';
  ctx.letterSpacing = '1.5px';
  ctx.fillText('AI FLUENCY', SCORE_CX, 354);
  ctx.letterSpacing = '0px';

  ctx.font = `600 11px ${FONT_STACK}`;
  ctx.fillStyle = '#4a4a62';
  ctx.letterSpacing = '2px';
  ctx.fillText('SCORE', SCORE_CX, 372);
  ctx.letterSpacing = '0px';

  ctx.textAlign = 'left';

  // ── Section 4: Fingerprint Bars (right zone, x=420 to x=1152) ────────────────

  const LABEL_LEFT_X = 420;
  const BAR_START_X = 560;
  const BAR_END_X = W - PAD; // 1152
  const BAR_MAX_W = BAR_END_X - BAR_START_X; // 592
  const BAR_H = 20;
  const BAR_RADIUS = 10;
  const ICON_SIZE = 16;
  const ICON_GAP = 8;
  const MIN_FILL_W = 20;

  for (const bar of FINGERPRINT_BARS) {
    const barY = bar.yCentre - BAR_H / 2;
    const score = props.dimensionScores
      ? (props.dimensionScores[bar.field as keyof PQDimensionScores] as number)
      : 0;

    // Draw bar track (full width pill)
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.roundRect(BAR_START_X, barY, BAR_MAX_W, BAR_H, BAR_RADIUS);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(BAR_START_X, barY, BAR_MAX_W, BAR_H, BAR_RADIUS);
    ctx.stroke();

    // Draw bar fill (colored pill, minimum 20px)
    const fillW = props.dimensionScores
      ? Math.max(MIN_FILL_W, Math.round((score / 100) * BAR_MAX_W))
      : 0;

    if (fillW > 0) {
      ctx.fillStyle = bar.color;
      ctx.beginPath();
      ctx.roundRect(BAR_START_X, barY, fillW, BAR_H, BAR_RADIUS);
      ctx.fill();
    }

    // Draw label: icon + text unit, right-aligned to end at BAR_START_X - 10
    ctx.font = `500 12px ${FONT_STACK}`;
    const labelTextW = ctx.measureText(bar.label).width;
    const totalLabelW = ICON_SIZE + ICON_GAP + labelTextW;
    const rightEdge = BAR_START_X - 10;
    const iconX = rightEdge - totalLabelW;
    const iconY = bar.yCentre - ICON_SIZE / 2;

    drawIcon(ctx, bar.icon, iconX, iconY, ICON_SIZE, bar.color);

    ctx.fillStyle = '#6b6b88';
    ctx.fillText(bar.label, iconX + ICON_SIZE + ICON_GAP, bar.yCentre + 4);
  }

  // ── Section 5: Evidence Lines (y=440, y=464) ──────────────────────────────────

  const EVIDENCE_CENTER_X = 600;

  // Line 1: [BarChart3 icon] {N} sessions · [Zap icon] {tokens}
  if (props.totalSessions > 0 || props.dimensionScores) {
    const ICON_SMALL = 14;
    const sessionLabel = `${props.totalSessions} session${props.totalSessions !== 1 ? 's' : ''}`;
    const tokenLabel = abbreviateTokens(props.totalTokens);
    const separatorLabel = ' · ';

    ctx.font = `500 15px ${FONT_STACK}`;
    const sessionW = ctx.measureText(sessionLabel).width;
    const tokenW = ctx.measureText(tokenLabel).width;
    const sepW = ctx.measureText(separatorLabel).width;

    // Total width: icon + gap + sessionLabel + separator + icon + gap + tokenLabel
    const line1TotalW = ICON_SMALL + 6 + sessionW + sepW + ICON_SMALL + 6 + tokenW;
    let x1 = EVIDENCE_CENTER_X - line1TotalW / 2;

    drawIcon(ctx, ICON_BAR_CHART_3, x1, 440 - ICON_SMALL / 2 - 1, ICON_SMALL, '#64748b');
    x1 += ICON_SMALL + 6;

    ctx.fillStyle = '#64748b';
    ctx.fillText(sessionLabel, x1, 440);
    x1 += sessionW;

    ctx.fillStyle = '#3a3a52';
    ctx.fillText(separatorLabel, x1, 440);
    x1 += sepW;

    drawIcon(ctx, ICON_ZAP, x1, 440 - ICON_SMALL / 2 - 1, ICON_SMALL, '#64748b');
    x1 += ICON_SMALL + 6;

    ctx.fillStyle = '#64748b';
    ctx.fillText(tokenLabel, x1, 440);
  } else {
    // 0 sessions fallback
    ctx.font = `500 15px ${FONT_STACK}`;
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.fillText('Get started at code-insights.app', EVIDENCE_CENTER_X, 440);
    ctx.textAlign = 'left';
  }

  // Line 2: {N} lifetime · [tool logos]
  {
    const lifetimeLabel = `${props.lifetimeSessions} lifetime`;
    const dedupedTools = deduplicateToolsForIcons(props.sourceTools).slice(0, 4);
    const LOGO_SIZE_PX = 18;
    const LOGO_GAP = 8;

    ctx.font = `400 14px ${FONT_STACK}`;
    const lifetimeW = ctx.measureText(lifetimeLabel).width;
    const sepLabel = ' · ';
    const sepW2 = ctx.measureText(sepLabel).width;

    // Calculate logos section width
    const logosCount = dedupedTools.filter(t => toolIcons.has(t)).length;
    const logosW = logosCount > 0 ? logosCount * LOGO_SIZE_PX + (logosCount - 1) * LOGO_GAP : 0;

    const line2TotalW = lifetimeW + (logosCount > 0 ? sepW2 + logosW : 0);
    let x2 = EVIDENCE_CENTER_X - line2TotalW / 2;

    ctx.fillStyle = '#475569';
    ctx.fillText(lifetimeLabel, x2, 464);
    x2 += lifetimeW;

    if (logosCount > 0) {
      ctx.fillStyle = '#3a3a52';
      ctx.fillText(sepLabel, x2, 464);
      x2 += sepW2;

      for (const tool of dedupedTools) {
        const img = toolIcons.get(tool);
        if (!img) continue;
        const cx = x2 + LOGO_SIZE_PX / 2;
        const cy = 464 - LOGO_SIZE_PX / 2 + 2;
        drawToolIcon(ctx, img, cx, cy, LOGO_SIZE_PX);
        x2 += LOGO_SIZE_PX + LOGO_GAP;
      }
    }
  }

  // ── Section 6: Footer (pinned to bottom) ─────────────────────────────────────

  const DIVIDER_Y = H - 120; // 510
  const FOOTER_Y = H - 70;   // 560

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, DIVIDER_Y);
  ctx.lineTo(W - PAD, DIVIDER_Y);
  ctx.stroke();

  const FOOTER_LOGO_SIZE = 20;
  drawLogo(ctx, PAD, FOOTER_Y - FOOTER_LOGO_SIZE + 2, FOOTER_LOGO_SIZE);

  ctx.font = `400 16px ${FONT_STACK}`;
  ctx.fillStyle = '#475569';
  ctx.fillText('code-insights.app', PAD + FOOTER_LOGO_SIZE + 10, FOOTER_Y);

  ctx.font = `500 15px ${FONT_STACK}`;
  ctx.fillStyle = '#6366f1';
  ctx.textAlign = 'right';
  ctx.fillText("What's yours?", W - PAD, FOOTER_Y);
  ctx.textAlign = 'left';
}

/**
 * Create an ephemeral canvas, draw the share card, and trigger a PNG download.
 * Async because tool logos need to be pre-loaded before drawing.
 */
export async function downloadShareCard(props: ShareCardProps): Promise<void> {
  // Pre-load tool logos before drawing (canvas drawImage requires loaded images)
  const toolIcons = await loadToolIcons(props.sourceTools);

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  drawShareCard(canvas, props, toolIcons);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png')
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'code-insights-ai-fluency.png';
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}
