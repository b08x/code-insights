export function preprocessText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits text into chunks based on a maximum length and preferred delimiters.
 * Falls back to smaller delimiters if a chunk exceeds maxLength.
 */
export function chunkText(
  text: string,
  maxLength: number,
  delimiters: string[] = ['\n\n', '\n', '.', '?', '!', ',', ' ']
): string[] {
  text = preprocessText(text);

  if (text.length <= maxLength) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let currentStart = 0;

  while (currentStart < text.length) {
    if (text.length - currentStart <= maxLength) {
      const remaining = text.slice(currentStart).trim();
      if (remaining.length > 0) chunks.push(remaining);
      break;
    }

    let splitIndex = -1;
    let foundDelimiterLength = 0;

    for (const delimiter of delimiters) {
      // Search for the last occurrence of the delimiter within the allowed window
      const searchWindow = text.slice(currentStart, currentStart + maxLength);
      const lastIdx = searchWindow.lastIndexOf(delimiter);
      
      // Ensure we make progress (lastIdx > 0) or if it's the very first char
      if (lastIdx > 0) {
        splitIndex = currentStart + lastIdx;
        foundDelimiterLength = delimiter.length;
        break;
      }
    }

    if (splitIndex === -1) {
      // Force split if no delimiters found
      splitIndex = currentStart + maxLength;
      foundDelimiterLength = 0;
    } else {
      // Include the delimiter in the chunk
      splitIndex += foundDelimiterLength;
    }

    const chunkStr = text.slice(currentStart, splitIndex).trim();
    if (chunkStr.length > 0) {
      chunks.push(chunkStr);
    }
    
    currentStart = splitIndex;
  }

  return chunks;
}
