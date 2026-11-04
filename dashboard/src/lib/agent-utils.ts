export function stringifySafe(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getAgentDisplayName(input: Record<string, any>): string {
  return stringifySafe(input.name || input.agent || input.agent_type || input.subagent_type || 'Agent');
}

export function getAgentInitials(name: string): string {
  const safeName = stringifySafe(name);
  const parts = safeName.split(/[-_\s]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return safeName.slice(0, 2).toUpperCase();
}
