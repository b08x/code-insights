/**
 * WorkingStyleShareCard — 552×290px shareable JPEG export card.
 *
 * CRITICAL RULES:
 * - ALL colors as hex or rgba() — NO CSS variables, NO Tailwind classes
 * - Use rgba() for any alpha transparency — 8-digit hex (#ffffff06) breaks html-to-image
 * - NO background-clip:text — html-to-image cannot serialize it; use solid color instead
 * - fontFamily: system-ui stack
 * - All sizing in px — NO rem, NO responsive units
 * - Rendered off-screen (position: absolute; left: -9999px) for html-to-image capture
 * - Privacy: never shows project names, file paths, session titles, cost data, or usernames
 */

import { forwardRef } from 'react';
import { ShareCardDonut } from './ShareCardDonut';
import {
  SOURCE_TOOL_DISPLAY_NAMES,
  SOURCE_TOOL_PILL_COLORS,
  computeMilestones,
} from '@/lib/share-card-utils';

// Donut segment colors — hex literals matching SESSION_CHARACTER_COLORS hues
const CHARACTER_DONUT_COLORS: Record<string, string> = {
  deep_focus:    '#6366f1',
  bug_hunt:      '#ef4444',
  feature_build: '#10b981',
  exploration:   '#f59e0b',
  refactor:      '#06b6d4',
  learning:      '#8b5cf6',
  quick_task:    '#64748b',
};

// Keep in sync with SESSION_CHARACTER_LABELS in dashboard/src/lib/constants/colors.ts
const CHARACTER_DISPLAY_NAMES: Record<string, string> = {
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

/**
 * Derive month + year label from an ISO week string (e.g. "2026-W11" → "Mar 2026").
 * Uses the Monday of that week — avoids showing the wrong month when viewing historical weeks.
 */
function getMonthYearFromWeek(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) {
    return new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  // Find Monday of ISO week 1: Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay();
  const daysToMonday = jan4Day === 0 ? 6 : jan4Day - 1;
  const week1Monday = new Date(jan4.getTime() - daysToMonday * 86400000);
  const weekMonday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  return weekMonday.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface WorkingStyleShareCardProps {
  tagline: string;
  totalSessions: number;
  streak: number;
  sourceTools: string[];
  characterDistribution: Record<string, number>;
  outcomeDistribution: Record<string, number>;
  currentWeek: string;  // ISO week string — determines footer month label (avoids showing wrong month for historical weeks)
}

export const WorkingStyleShareCard = forwardRef<HTMLDivElement, WorkingStyleShareCardProps>(
  function WorkingStyleShareCard(
    { tagline, totalSessions, streak, sourceTools, characterDistribution, outcomeDistribution, currentWeek },
    ref
  ) {
    // Compute success rate (high outcomes / total faceted sessions)
    const outcomeTotal = Object.values(outcomeDistribution).reduce((s, v) => s + v, 0);
    const successCount = outcomeDistribution['high'] ?? 0;
    const successRate = outcomeTotal > 0 ? Math.round((successCount / outcomeTotal) * 100) : 0;

    // Build donut data: top 3 character types + "Other"
    const sortedChars = Object.entries(characterDistribution)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    const top3 = sortedChars.slice(0, 3);
    const otherSum = sortedChars.slice(3).reduce((s, [, v]) => s + v, 0);
    const donutData = [
      ...top3.map(([key, value]) => ({
        label: CHARACTER_DISPLAY_NAMES[key] ?? key,
        value,
        color: CHARACTER_DONUT_COLORS[key] ?? '#64748b',
      })),
      ...(otherSum > 0 ? [{ label: 'Other', value: otherSum, color: '#334155' }] : []),
    ];

    const milestones = computeMilestones(totalSessions, streak, sourceTools.length, successRate);

    const hasTools = sourceTools.length > 0;
    const hasMilestones = milestones.length > 0;
    const hasDonut = donutData.length > 0;

    return (
      <div
        ref={ref}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 0,
          width: '552px',
          height: '290px',
          fontFamily: FONT_STACK,
          overflow: 'hidden',
          // Solid background — html-to-image toJpeg backgroundColor handles base color,
          // gradient is layered via inner div for better serialization compat
          backgroundColor: '#0f0f23',
        }}
      >
        {/* Gradient overlay — separate div for html-to-image compat */}
        {/* zIndex: 0 + explicit sides (not inset shorthand) — SVG foreignObject doesn't reliably preserve DOM-order stacking */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 0,
            background: 'linear-gradient(135deg, #0f0f23 0%, #1a1a3e 100%)',
          }}
        />

        {/* Radial glow accents — rgba() instead of 8-digit hex for html-to-image compat */}
        <div
          style={{
            position: 'absolute',
            top: '-37px',
            left: '-37px',
            width: '184px',
            height: '184px',
            borderRadius: '50%',
            zIndex: 0,
            background: 'radial-gradient(circle, rgba(59,130,246,0.13) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-46px',
            right: '-37px',
            width: '230px',
            height: '230px',
            borderRadius: '50%',
            zIndex: 0,
            background: 'radial-gradient(circle, rgba(168,85,247,0.09) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        {/* Content area — zIndex: 1 ensures content renders above overlay/glows in SVG foreignObject */}
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '18px',
            height: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* ── Top: Logo + app name ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '8px' }}>
            {/* App logo SVG */}
            <svg width="13" height="13" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="7" fill="#3b82f6" />
              <path d="M8 10h12M8 14h8M8 18h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span
              style={{
                fontSize: '6px',
                color: '#a0a0b8',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              Code Insights
            </span>
          </div>

          {/* ── Tagline ── */}
          {/* Solid color — html-to-image cannot render background-clip:text gradient */}
          <p
            style={{
              fontSize: '19px',
              fontWeight: 700,
              lineHeight: 1.15,
              margin: '0 0 11px 0',
              color: '#a78bfa',
              maxWidth: '414px',
            }}
          >
            {tagline}
          </p>

          {/* ── Stat boxes ── */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '11px' }}>
            {[
              { value: abbreviateCount(totalSessions), label: 'Sessions' },
              { value: streak > 0 ? `${streak}d` : '—', label: 'Streak' },
              { value: outcomeTotal > 0 ? `${successRate}%` : '—', label: 'Success' },
            ].map(({ value, label }) => (
              <div
                key={label}
                style={{
                  width: '65px',
                  height: '30px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(255,255,255,0.024)',
                  border: '1px solid rgba(255,255,255,0.063)',
                  padding: '4px 7px',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', lineHeight: 1 }}>
                  {value}
                </span>
                <span
                  style={{
                    fontSize: '5px',
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginTop: '1px',
                  }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* ── Middle zone: tools + milestones LEFT, donut RIGHT (side-by-side at 552px) ── */}
          <div style={{ display: 'flex', flex: 1, gap: '12px', alignItems: 'flex-start', minHeight: 0 }}>
            {/* LEFT — tools + milestones */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
              {/* Tool pills */}
              {hasTools && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {sourceTools.map((tool) => {
                    const colors = SOURCE_TOOL_PILL_COLORS[tool] ?? {
                      bg: '#1e293b', text: '#94a3b8', border: 'rgba(148,163,184,0.3)',
                    };
                    return (
                      <span
                        key={tool}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '2px 5px',
                          borderRadius: '999px',
                          fontSize: '6px',
                          fontWeight: 500,
                          backgroundColor: colors.bg,
                          color: colors.text,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        {SOURCE_TOOL_DISPLAY_NAMES[tool] ?? tool}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Milestone pills */}
              {hasMilestones && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {milestones.map((m, i) => (
                    <span
                      key={i}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        padding: '2px 5px',
                        borderRadius: '999px',
                        fontSize: '6px',
                        fontWeight: 500,
                        backgroundColor: 'rgba(255,255,255,0.04)',
                        color: '#94a3b8',
                        border: '1px solid rgba(255,255,255,0.12)',
                      }}
                    >
                      <span style={{ color: m.iconColor }}>{m.icon}</span>
                      {m.label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* RIGHT — donut */}
            {hasDonut && (
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <ShareCardDonut data={donutData} size={85} strokeWidth={12} />
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div style={{ marginTop: 'auto', paddingTop: '7px' }}>
            <div style={{ height: '1px', backgroundColor: 'rgba(255,255,255,0.07)', marginBottom: '6px' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <svg width="8" height="8" viewBox="0 0 28 28" fill="none">
                  <rect width="28" height="28" rx="7" fill="#3b82f6" />
                  <path d="M8 10h12M8 14h8M8 18h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span style={{ fontSize: '6px', color: '#64748b' }}>code-insights.app</span>
              </div>
              <span style={{ fontSize: '6px', color: '#475569' }}>
                Patterns · {getMonthYearFromWeek(currentWeek)}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
