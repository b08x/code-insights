import { describe, it, expect } from 'vitest';
import { getAssistantConfig } from '../message-attribution';
import { TOOL_ALIASES } from '../tool-aliases';
import { getAgentDisplayName, getAgentInitials } from '../agent-utils';

describe('Message attribution & tool panels', () => {
  describe('getAssistantConfig', () => {
    it('maps mistral-vibe to Mistral Vibe and bg-orange-600', () => {
      const config = getAssistantConfig('mistral-vibe');
      expect(config.name).toBe('Mistral Vibe');
      expect(config.avatarColor).toBe('bg-orange-600');
    });

    it('maps antigravity to Antigravity and bg-blue-600', () => {
      const config = getAssistantConfig('antigravity');
      expect(config.name).toBe('Antigravity');
      expect(config.avatarColor).toBe('bg-blue-600');
    });

    it('maps crush to Crush and bg-rose-500', () => {
      const config = getAssistantConfig('crush');
      expect(config.name).toBe('Crush');
      expect(config.avatarColor).toBe('bg-rose-500');
    });

    it('defaults unknown providers to Claude and bg-purple-500', () => {
      const config = getAssistantConfig('unknown-provider');
      expect(config.name).toBe('Claude');
      expect(config.avatarColor).toBe('bg-purple-500');
    });
  });

  describe('TOOL_ALIASES', () => {
    it('maps agents.spawn to Task', () => {
      expect(TOOL_ALIASES['agents.spawn']).toBe('Task');
    });

    it('maps subagent.spawn to Task', () => {
      expect(TOOL_ALIASES['subagent.spawn']).toBe('Task');
    });

    it('maps task to Task', () => {
      expect(TOOL_ALIASES['task']).toBe('Task');
    });

    it('maps delegate_task to Task', () => {
      expect(TOOL_ALIASES['delegate_task']).toBe('Task');
    });
  });

  describe('AgentToolPanel argument extraction', () => {
    it('extracts agent name from name, agent, agent_type, or subagent_type', () => {
      expect(getAgentDisplayName({ name: 'Specialist' })).toBe('Specialist');
      expect(getAgentDisplayName({ agent: 'cleaner' })).toBe('cleaner');
      expect(getAgentDisplayName({ agent_type: 'ruby-dev:verifier' })).toBe('ruby-dev:verifier');
      expect(getAgentDisplayName({ subagent_type: 'general-purpose' })).toBe('general-purpose');
      expect(getAgentDisplayName({})).toBe('Agent');
    });

    it('generates initials from multi-word or hyphenated agent names', () => {
      expect(getAgentInitials('ruby-dev')).toBe('RD');
      expect(getAgentInitials('Code Reviewer')).toBe('CR');
      expect(getAgentInitials('agent')).toBe('AG');
    });
  });
});
