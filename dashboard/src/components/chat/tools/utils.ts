/** Parse JSON input safely, return empty object on failure. */
export function parseToolInput(input: string): Record<string, any> {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

/**
 * Ensure a value is a string. If it's an object, stringify it.
 * Prevents React Error #31 (Objects are not valid as a React child).
 */
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
