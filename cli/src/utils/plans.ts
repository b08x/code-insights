import type { PricingPlan, PlanBreakdownItem, ClaudeInsightConfig, Period } from '../types.js';

/**
 * Default pricing plans for AI coding tools.
 * Sourced from user's active paid subscriptions:
 *   - Google One AI Premium / Gemini Advanced / Antigravity: $19.99/mo
 *   - Claude Pro: $21.00/mo (e.g. $20/mo + tax)
 *   - Mistral Pro: $14.99/mo
 *   - OpenRouter: Pay-as-you-go per-token
 *   - Free / Local: Ollama
 *   - Fallback: Pay-As-You-Go API for tools without subscription
 */
export const DEFAULT_PLANS: Record<string, PricingPlan> = {
  gemini: {
    id: 'gemini',
    name: 'Google AI Premium (Antigravity/Gemini)',
    type: 'subscription',
    monthlyFee: 19.99,
    tools: ['antigravity', 'gemini-cli', 'gemini'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Pro',
    type: 'subscription',
    monthlyFee: 21.00,
    tools: ['claude-code', 'claude-desktop'],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral Pro',
    type: 'subscription',
    monthlyFee: 14.99,
    tools: ['mistral-vibe', 'mistral'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter (Pay-As-You-Go)',
    type: 'pay_as_you_go',
    tools: ['openrouter'],
  },
  free: {
    id: 'free',
    name: 'Local / Free',
    type: 'free',
    tools: ['ollama'],
  },
  pay_as_you_go: {
    id: 'pay_as_you_go',
    name: 'Pay-As-You-Go API',
    type: 'pay_as_you_go',
    tools: ['cursor', 'crush', 'opencode', 'hermes-agent', 'pi', 'codex-cli', 'codex'],
  },
};

/**
 * Merge user-configured plans with defaults.
 */
export function getEffectivePlans(config?: ClaudeInsightConfig | null): Record<string, PricingPlan> {
  const plans: Record<string, PricingPlan> = {};

  // Clone defaults
  for (const [key, plan] of Object.entries(DEFAULT_PLANS)) {
    plans[key] = { ...plan, tools: [...plan.tools] };
  }

  // Overlay user custom plans if present
  if (config?.plans) {
    for (const [key, userPlan] of Object.entries(config.plans)) {
      if (plans[key]) {
        plans[key] = {
          ...plans[key],
          ...userPlan,
          tools: userPlan.tools && userPlan.tools.length > 0 ? [...userPlan.tools] : plans[key].tools,
        };
      } else {
        plans[key] = {
          id: userPlan.id || key,
          name: userPlan.name || key,
          type: userPlan.type || 'pay_as_you_go',
          monthlyFee: userPlan.monthlyFee,
          tools: userPlan.tools ? [...userPlan.tools] : [],
        };
      }
    }
  }

  return plans;
}

/**
 * Find the plan for a given source tool name.
 */
export function findPlanForTool(tool: string, plans?: Record<string, PricingPlan>): PricingPlan {
  const activePlans = plans ?? DEFAULT_PLANS;
  const normalizedTool = tool.toLowerCase().trim();

  for (const plan of Object.values(activePlans)) {
    if (plan.tools.some(t => t.toLowerCase() === normalizedTool)) {
      return plan;
    }
  }

  // Fallback to pay_as_you_go
  return activePlans.pay_as_you_go ?? DEFAULT_PLANS.pay_as_you_go;
}

export interface SessionPlanInput {
  sourceTool?: string;
  source_tool?: string;
  startedAt?: Date | string;
  started_at?: Date | string;
  estimatedCostUsd?: number | null;
  estimated_cost_usd?: number | null;
}

/**
 * Calculate cost breakdown per plan for a given period.
 */
export function calculatePlansBreakdown(
  sessions: SessionPlanInput[],
  period: Period | string,
  plans?: Record<string, PricingPlan>,
): PlanBreakdownItem[] {
  const activePlans = plans ?? DEFAULT_PLANS;
  const sessionsByPlan = new Map<string, SessionPlanInput[]>();

  // Initialize all known plans with empty session arrays
  for (const planId of Object.keys(activePlans)) {
    sessionsByPlan.set(planId, []);
  }

  for (const s of sessions) {
    const tool = s.sourceTool ?? s.source_tool ?? 'claude-code';
    const plan = findPlanForTool(tool, activePlans);
    const list = sessionsByPlan.get(plan.id) ?? [];
    list.push(s);
    sessionsByPlan.set(plan.id, list);
  }

  const breakdown: PlanBreakdownItem[] = [];

  for (const [planId, plan] of Object.entries(activePlans)) {
    const planSessions = sessionsByPlan.get(planId) ?? [];
    const sessionCount = planSessions.length;
    const tokenValue = Math.round(
      planSessions.reduce((sum, s) => sum + (s.estimatedCostUsd ?? s.estimated_cost_usd ?? 0), 0) * 10000,
    ) / 10000;

    let actualCost = 0;

    if (sessionCount === 0) {
      actualCost = 0;
    } else if (plan.type === 'free') {
      actualCost = 0;
    } else if (plan.type === 'pay_as_you_go') {
      actualCost = tokenValue;
    } else if (plan.type === 'subscription') {
      const monthlyFee = plan.monthlyFee ?? 0;
      if (period === '7d') {
        // Prorate 7 days over 30.4375 average days in a month
        actualCost = Math.round((monthlyFee * (7 / 30.4375)) * 100) / 100;
      } else if (period === '30d') {
        actualCost = monthlyFee;
      } else if (period === '90d') {
        actualCost = Math.round((monthlyFee * 3) * 100) / 100;
      } else {
        // 'all' or custom: compute number of distinct active calendar months
        const activeMonths = new Set(
          planSessions.map(s => {
            const rawDate = s.startedAt ?? s.started_at;
            const date = rawDate instanceof Date ? rawDate : rawDate ? new Date(rawDate) : new Date();
            return date.toISOString().slice(0, 7);
          }),
        ).size;
        actualCost = Math.round((Math.max(1, activeMonths) * monthlyFee) * 100) / 100;
      }
    }

    const savings = Math.max(0, Math.round((tokenValue - actualCost) * 10000) / 10000);

    breakdown.push({
      id: plan.id,
      name: plan.name,
      type: plan.type,
      monthlyFee: plan.monthlyFee,
      actualCost,
      tokenValue,
      savings,
      sessionCount,
      tools: plan.tools,
    });
  }

  // Sort: active plans with sessions first (by actualCost desc, then tokenValue desc), then inactive plans
  return breakdown.sort((a, b) => {
    if (a.sessionCount > 0 && b.sessionCount === 0) return -1;
    if (a.sessionCount === 0 && b.sessionCount > 0) return 1;
    if (b.actualCost !== a.actualCost) return b.actualCost - a.actualCost;
    return b.tokenValue - a.tokenValue;
  });
}
