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
