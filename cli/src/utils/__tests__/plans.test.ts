import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLANS,
  getEffectivePlans,
  findPlanForTool,
  calculatePlansBreakdown,
  SessionPlanInput,
} from '../plans.js';

describe('plans utility', () => {
  describe('DEFAULT_PLANS', () => {
    it('has gemini plan configured at 19.99/mo with antigravity and gemini-cli tools', () => {
      const gemini = DEFAULT_PLANS.gemini;
      expect(gemini).toBeDefined();
      expect(gemini.type).toBe('subscription');
      expect(gemini.monthlyFee).toBe(19.99);
      expect(gemini.tools).toContain('antigravity');
      expect(gemini.tools).toContain('gemini-cli');
    });

    it('has claude plan configured at 21.00/mo with claude-code and claude-desktop tools', () => {
      const claude = DEFAULT_PLANS.claude;
      expect(claude).toBeDefined();
      expect(claude.type).toBe('subscription');
      expect(claude.monthlyFee).toBe(21.00);
      expect(claude.tools).toContain('claude-code');
    });

    it('has mistral plan configured at 14.99/mo with mistral-vibe tools', () => {
      const mistral = DEFAULT_PLANS.mistral;
      expect(mistral).toBeDefined();
      expect(mistral.type).toBe('subscription');
      expect(mistral.monthlyFee).toBe(14.99);
      expect(mistral.tools).toContain('mistral-vibe');
    });

    it('has openrouter plan configured as pay_as_you_go', () => {
      const openrouter = DEFAULT_PLANS.openrouter;
      expect(openrouter).toBeDefined();
      expect(openrouter.type).toBe('pay_as_you_go');
      expect(openrouter.tools).toContain('openrouter');
    });
  });

  describe('getEffectivePlans', () => {
    it('returns default plans when config is empty or missing plans', () => {
      const plans = getEffectivePlans();
      expect(plans.gemini.monthlyFee).toBe(19.99);
      expect(plans.claude.monthlyFee).toBe(21.00);
      expect(plans.mistral.monthlyFee).toBe(14.99);
    });

    it('merges user plan overrides with defaults', () => {
      const plans = getEffectivePlans({
        sync: { claudeDir: '', excludeProjects: [] },
        plans: {
          claude: {
            id: 'claude',
            name: 'Claude Custom',
            type: 'subscription',
            monthlyFee: 25.00,
            tools: ['claude-code'],
          },
        },
      });
      expect(plans.claude.monthlyFee).toBe(25.00);
      expect(plans.claude.name).toBe('Claude Custom');
      expect(plans.gemini.monthlyFee).toBe(19.99); // unchanged
    });
  });

  describe('findPlanForTool', () => {
    it('matches tools to their respective plans case-insensitively', () => {
      expect(findPlanForTool('antigravity').id).toBe('gemini');
      expect(findPlanForTool('Antigravity').id).toBe('gemini');
      expect(findPlanForTool('gemini-cli').id).toBe('gemini');
      expect(findPlanForTool('claude-code').id).toBe('claude');
      expect(findPlanForTool('mistral-vibe').id).toBe('mistral');
      expect(findPlanForTool('openrouter').id).toBe('openrouter');
    });

    it('falls back to pay_as_you_go for unknown tools', () => {
      expect(findPlanForTool('custom-cli').id).toBe('pay_as_you_go');
    });
  });

  describe('calculatePlansBreakdown', () => {
    const sampleSessions: SessionPlanInput[] = [
      {
        source_tool: 'antigravity',
        started_at: '2026-09-01T10:00:00Z',
        estimated_cost_usd: 12.50,
      },
      {
        source_tool: 'antigravity',
        started_at: '2026-09-15T12:00:00Z',
        estimated_cost_usd: 18.00,
      },
      {
        sourceTool: 'claude-code',
        startedAt: '2026-09-10T08:00:00Z',
        estimatedCostUsd: 45.00,
      },
      {
        source_tool: 'openrouter',
        started_at: '2026-09-05T09:00:00Z',
        estimated_cost_usd: 3.25,
      },
    ];

    it('calculates 30d breakdown correctly', () => {
      const breakdown = calculatePlansBreakdown(sampleSessions, '30d');
      const gemini = breakdown.find(p => p.id === 'gemini')!;
      const claude = breakdown.find(p => p.id === 'claude')!;
      const openrouter = breakdown.find(p => p.id === 'openrouter')!;

      // Gemini: 2 sessions, token value = 30.50, actual cost = 19.99 flat, savings = 10.51
      expect(gemini.sessionCount).toBe(2);
      expect(gemini.tokenValue).toBe(30.50);
      expect(gemini.actualCost).toBe(19.99);
      expect(gemini.savings).toBe(10.51);

      // Claude: 1 session, token value = 45.00, actual cost = 21.00 flat, savings = 24.00
      expect(claude.sessionCount).toBe(1);
      expect(claude.tokenValue).toBe(45.00);
      expect(claude.actualCost).toBe(21.00);
      expect(claude.savings).toBe(24.00);

      // OpenRouter: pay-as-you-go, token value = 3.25, actual cost = 3.25, savings = 0
      expect(openrouter.sessionCount).toBe(1);
      expect(openrouter.tokenValue).toBe(3.25);
      expect(openrouter.actualCost).toBe(3.25);
      expect(openrouter.savings).toBe(0);
    });

    it('calculates 7d prorated breakdown correctly', () => {
      const breakdown = calculatePlansBreakdown(sampleSessions, '7d');
      const gemini = breakdown.find(p => p.id === 'gemini')!;
      // 19.99 * (7 / 30.4375) ~= 4.60
      expect(gemini.actualCost).toBeCloseTo(4.60, 1);
    });

    it('calculates 90d breakdown correctly', () => {
      const breakdown = calculatePlansBreakdown(sampleSessions, '90d');
      const gemini = breakdown.find(p => p.id === 'gemini')!;
      // 19.99 * 3 = 59.97
      expect(gemini.actualCost).toBe(59.97);
    });

    it('calculates all-time breakdown with distinct active months', () => {
      const multiMonthSessions: SessionPlanInput[] = [
        { sourceTool: 'antigravity', startedAt: '2026-07-01T10:00:00Z', estimatedCostUsd: 10 },
        { sourceTool: 'antigravity', startedAt: '2026-08-01T10:00:00Z', estimatedCostUsd: 10 },
        { sourceTool: 'antigravity', startedAt: '2026-09-01T10:00:00Z', estimatedCostUsd: 10 },
      ];
      const breakdown = calculatePlansBreakdown(multiMonthSessions, 'all');
      const gemini = breakdown.find(p => p.id === 'gemini')!;
      // 3 distinct months * 19.99 = 59.97
      expect(gemini.sessionCount).toBe(3);
      expect(gemini.actualCost).toBe(59.97);
    });
  });
});
