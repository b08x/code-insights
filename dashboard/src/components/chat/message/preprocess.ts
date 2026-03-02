/**
 * Preprocess markdown content to convert Insight blocks into styled blockquotes.
 * Matches: `★ Insight ───...` through `───...`
 */
export function preprocessInsightBlocks(content: string): string {
  return content.replace(
    /`★ Insight[─━\-]+`\n([\s\S]*?)\n`[─━\-]+`/g,
    (_, body) => `> **★ Insight**\n>\n> ${body.split('\n').join('\n> ')}`
  );
}

// ─── Agent message types ──────────────────────────────────────────────────────

export interface ParsedTaskNotification {
  kind: 'task-notification';
  taskId?: string;
  status?: string;
  summary?: string;
  result?: string;
  usage?: { tokens?: string; duration?: string; toolUses?: string };
  transcriptPath?: string;
}

export interface ParsedTeammateMessage {
  kind: 'teammate-message';
  teammateId?: string;
  color?: string;
  from?: string;
  type?: string;
  summary?: string;
  content?: string;
  rawContent: string;
}

export type ParsedAgentMessage = ParsedTaskNotification | ParsedTeammateMessage;

/**
 * Fast check: does this content contain agent message XML tags?
 * Uses string.includes() for the hot path — no regex overhead for 99% of messages.
 */
export function isAgentMessage(content: string): boolean {
  return content.includes('<task-notification>') || content.includes('<teammate-message');
}

/**
 * Parse agent message content into a typed struct.
 * Returns null if content doesn't match any known agent message pattern.
 */
export function parseAgentMessage(content: string): ParsedAgentMessage | null {
  if (content.includes('<task-notification>')) {
    return parseTaskNotification(content);
  }
  if (content.includes('<teammate-message')) {
    return parseTeammateMessage(content);
  }
  return null;
}

/**
 * Extract the text content of an XML-like tag from a string.
 * Uses a lazy quantifier (*?) so it matches up to the FIRST closing tag.
 * This means nested same-name tags would cause truncation — acceptable
 * because Claude Code's agent message format does not produce nested
 * same-name tags, and the same pattern is used by preprocessUserContent.
 */
function extractTag(content: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(content);
  return match ? match[1].trim() : undefined;
}

function parseTaskNotification(content: string): ParsedTaskNotification {
  const taskId = extractTag(content, 'task_id');
  const status = extractTag(content, 'status');
  const summary = extractTag(content, 'summary');
  const result = extractTag(content, 'result');

  // Parse usage block for tokens, duration, tool_uses lines
  const usageBlock = extractTag(content, 'usage');
  let usage: ParsedTaskNotification['usage'];
  if (usageBlock) {
    const tokensMatch = /total_tokens:\s*(\S+)/.exec(usageBlock);
    const durationMatch = /duration:\s*(\S+)/.exec(usageBlock);
    const toolUsesMatch = /tool_uses:\s*(\S+)/.exec(usageBlock);
    usage = {
      tokens: tokensMatch ? tokensMatch[1] : undefined,
      duration: durationMatch ? durationMatch[1] : undefined,
      toolUses: toolUsesMatch ? toolUsesMatch[1] : undefined,
    };
  }

  // Transcript path: text AFTER </task-notification>, look for a path starting with /
  const afterTag = content.split('</task-notification>')[1] ?? '';
  const pathMatch = /^\s*(\/[^\s]+)/m.exec(afterTag);
  const transcriptPath = pathMatch ? pathMatch[1] : undefined;

  return { kind: 'task-notification', taskId, status, summary, result, usage, transcriptPath };
}

function parseTeammateMessage(content: string): ParsedTeammateMessage {
  // Extract attributes from opening tag: <teammate-message teammate_id="..." color="...">
  const tagMatch = /<teammate-message([^>]*)>/.exec(content);
  const attrs = tagMatch ? tagMatch[1] : '';

  const teammateIdMatch = /teammate_id="([^"]*)"/.exec(attrs);
  const colorMatch = /color="([^"]*)"/.exec(attrs);

  const teammateId = teammateIdMatch ? teammateIdMatch[1] : undefined;
  const color = colorMatch ? colorMatch[1] : undefined;

  // Inner content between > and </teammate-message>
  const innerMatch = /<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/.exec(content);
  const rawContent = innerMatch ? innerMatch[1].trim() : content;

  // Try to parse as JSON for type, from, summary, content fields
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    return {
      kind: 'teammate-message',
      teammateId,
      color,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      content: typeof parsed.content === 'string' ? parsed.content : undefined,
      rawContent,
    };
  } catch {
    return { kind: 'teammate-message', teammateId, color, rawContent };
  }
}

// ─── User content preprocessing ───────────────────────────────────────────────

/**
 * Preprocess user message content to handle slash command XML tags from Claude Code sessions.
 * - <command-name>/foo</command-name> → `/foo`
 * - <command-message>...</command-message> → stripped
 * - <command-args>...</command-args> → stripped
 * - <local-command-stdout>text</local-command-stdout> → code block output
 */
export function preprocessUserContent(content: string): string {
  let result = content;

  // Strip <command-message>...</command-message>
  result = result.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');

  // Strip <command-args>...</command-args>
  result = result.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');

  // Replace <command-name>/foo</command-name> with `/foo`
  result = result.replace(/<command-name>(\/[^<]*)<\/command-name>/g, '`$1`');

  // Replace <local-command-stdout>text</local-command-stdout> with a code block
  result = result.replace(
    /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g,
    (_, stdout) => {
      const trimmed = stdout.trim();
      if (!trimmed) return '';
      return `\n\`\`\`\n${trimmed}\n\`\`\``;
    }
  );

  // Clean up excess blank lines from stripping
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}
