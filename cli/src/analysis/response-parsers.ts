// LLM response parsing utilities.
// Extracted from prompts.ts — handles JSON extraction, repair, and validation.

import { jsonrepair } from 'jsonrepair';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AnalysisResponse, ParseError, ParseResult, PromptQualityResponse, PromptQualityDimensionScores } from './prompt-types.js';

function buildResponsePreview(text: string, head = 500, tail = 500): string {
  if (text.length <= head + tail + 20) return text;
  return `${text.slice(0, head)}\n...[${text.length - head - tail} chars omitted]...\n${text.slice(-tail)}`;
}

export function extractJsonPayload(response: string): string | null {
  // 1. Tagged content (preferred)
  const tagged = response.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (tagged?.[1]) return tagged[1].trim();

  // 2. Markdown code blocks (common LLM output)
  const codeBlock = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlock?.[1]) return codeBlock[1].trim();

  // 3. Look for the largest balanced { ... } block.
  let bestBlock: string | null = null;
  let firstBrace = response.indexOf('{');

  while (firstBrace !== -1) {
    let depth = 0;
    let inQuote = false;
    let escaped = false;

    for (let i = firstBrace; i < response.length; i++) {
      const char = response[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inQuote = !inQuote; continue; }

      if (!inQuote) {
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            const block = response.slice(firstBrace, i + 1);
            if (!bestBlock || block.length > bestBlock.length) {
              bestBlock = block;
            }
            break;
          }
        }
      }
    }
    firstBrace = response.indexOf('{', firstBrace + 1);
  }

  if (bestBlock) return bestBlock;

  // 4. Truncated fallback: find the first { and return everything from there.
  const startIdx = response.indexOf('{');
  if (startIdx !== -1) {
    return response.slice(startIdx);
  }

  return null;
}

/**
 * Attempt to fix common LLM JSON mistakes that jsonrepair might struggle with,
 * specifically unescaped quotes in property values that can be confused with keys,
 * and literal newlines in strings.
 */
export function preProcessJson(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lastSignificantChar = '';
  let stringBraceDepth = 0;
  let stringBracketDepth = 0;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    // Handle literal newlines in strings
    if ((char === '\n' || char === '\r') && inString) {
      result += '\\n';
      // If it's \r\n, skip the \n
      if (char === '\r' && json[i + 1] === '\n') {
        i++;
      }
      continue;
    }

    if (char === '"') {
      if (inString) {
        // We are in a string. Is this the end of the string?
        let nextNonWhitespaceIdx = -1;
        let nextChar = '';
        for (let j = i + 1; j < json.length; j++) {
          if (!/\s/.test(json[j])) {
            nextNonWhitespaceIdx = j;
            nextChar = json[j];
            break;
          }
        }

        // A quote is likely an end of a string if it's followed by , } ] or :
        // OR if it's the end of the input.
        let isLikelyEnd = false;

        if (nextNonWhitespaceIdx === -1) {
          isLikelyEnd = true;
        } else if (['}', ']'].includes(nextChar)) {
          // If followed by } or ], it's an end-quote ONLY if we're not inside
          // a nested structure that we haven't closed yet.
          if (nextChar === '}' && stringBraceDepth <= 0) isLikelyEnd = true;
          if (nextChar === ']' && stringBracketDepth <= 0) isLikelyEnd = true;
        } else if (nextChar === ',') {
          // If followed by a comma, it's only an end quote if the NEXT non-whitespace
          // after the comma looks like the start of a new key or value.
          // ALSO check that we're not deep in a nested structure within the string.
          if (stringBraceDepth <= 0 && stringBracketDepth <= 0) {
            let nextNextChar = '';
            for (let j = nextNonWhitespaceIdx + 1; j < json.length; j++) {
              if (!/\s/.test(json[j])) {
                nextNextChar = json[j];
                break;
              }
            }
            // Valid starts for the next element in JSON:
            // " (key/string), { (object), [ (array), t/f/n (literals), -/digit (numbers)
            const validStarts = ['"', '{', '[', '}', ']', 't', 'f', 'n', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
            if (validStarts.includes(nextNextChar) || nextNextChar === '') {
              isLikelyEnd = true;
            }
          }
        } else if (nextChar === ':') {
          // If we see a colon, this is an end quote ONLY if we are currently defining a key.
          // We are defining a key if the last significant char before this string was { or , or [
          if (['{', ',', '['].includes(lastSignificantChar)) {
            isLikelyEnd = true;
          }
        }

        if (isLikelyEnd) {
          inString = false;
          result += char;
          lastSignificantChar = '"';
        } else {
          // Nested quote! Escape it.
          result += '\\"';
        }
      } else {
        inString = true;
        stringBraceDepth = 0;
        stringBracketDepth = 0;
        result += char;
      }
    } else {
      result += char;
      if (!/\s/.test(char)) {
        if (!inString) {
          lastSignificantChar = char;
        } else {
          // Track depth of braces/brackets WITHIN the string content
          if (char === '{') stringBraceDepth++;
          if (char === '}') stringBraceDepth--;
          if (char === '[') stringBracketDepth++;
          if (char === ']') stringBracketDepth--;
        }
      }
    }
  }
  return result;
}

/**
 * Log context around an error position and save full failed payload to a debug folder.
 */
function logParseErrorWithContext(json: string, err: unknown, contextName: string, rawResponse: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  const position = (err as any)?.position;

  // Save to debug folder
  try {
    const debugDir = join(homedir(), '.code-insights', 'debug');
    mkdirSync(debugDir, { recursive: true });
    const filename = `failed-${contextName}-${Date.now()}.json.txt`;
    const fullPath = join(debugDir, filename);
    writeFileSync(fullPath, `--- ERROR ---\n${msg}\n\n--- PRE-PROCESSED JSON ---\n${json}\n\n--- RAW RESPONSE ---\n${rawResponse}`);
    console.error(`[debug] Full failed payload saved to ${fullPath}`);
  } catch (saveErr) {
    console.warn('[debug] Failed to save debug payload:', saveErr);
  }

  if (typeof position === 'number') {
    const start = Math.max(0, position - 50);
    const end = Math.min(json.length, position + 50);
    const context = json.slice(start, end);
    const pointer = ' '.repeat(Math.min(position, 50)) + '^';
    console.error(`Failed to parse ${contextName} response (after jsonrepair): ${msg}`);
    console.error(`Context around position ${position}:`);
    console.error(context);
    console.error(pointer);
  } else {
    console.error(`Failed to parse ${contextName} response (after jsonrepair):`, err);
  }
}

/**
 * Parse the LLM response into structured insights.
 */
export function parseAnalysisResponse(response: string): ParseResult<AnalysisResponse> {
  const response_length = response.length;
  const preview = buildResponsePreview(response);

  const jsonPayload = extractJsonPayload(response);
  if (!jsonPayload) {
    console.error('No JSON found in analysis response');
    return {
      success: false,
      error: { error_type: 'no_json_found', error_message: 'No JSON found in analysis response', response_length, response_preview: preview },
    };
  }

  const preProcessed = preProcessJson(jsonPayload);

  let parsed: AnalysisResponse;
  try {
    parsed = JSON.parse(preProcessed) as AnalysisResponse;
  } catch {
    // Attempt repair — handles trailing commas, unclosed braces, truncated output
    try {
      const repaired = jsonrepair(preProcessed);
      parsed = JSON.parse(repaired) as AnalysisResponse;
    } catch (err) {
      logParseErrorWithContext(preProcessed, err, 'analysis', response);
      const msg = err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: { error_type: 'json_parse_error', error_message: msg, response_length, response_preview: preview },
      };
    }
  }

  if (!parsed.summary || typeof parsed.summary.title !== 'string') {
    console.error('Invalid analysis response structure');
    return {
      success: false,
      error: { error_type: 'invalid_structure', error_message: 'Missing or invalid summary field', response_length, response_preview: preview },
    };
  }

  // Guard against LLM returning non-array values (e.g. "decisions": "none").
  // || [] alone won't catch truthy non-arrays — Array.isArray is required.
  parsed.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  parsed.learnings = Array.isArray(parsed.learnings) ? parsed.learnings : [];

  // Normalize facet arrays before monitors access .some() — a non-array truthy value
  // (e.g. LLM returns "friction_points": "none") would throw a TypeError on .some().
  if (parsed.facets) {
    if (!Array.isArray(parsed.facets.friction_points)) parsed.facets.friction_points = [];
    if (!Array.isArray(parsed.facets.effective_patterns)) parsed.facets.effective_patterns = [];
  }

  // Observability: two-tier tooling-limitation monitor.
  // Tier 1: _reasoning contains misclassification signals NOT in a negation context → likely wrong category.
  // Tier 2: no conflicting signals (or signal was negated) → generic reminder to verify.
  // Re-evaluate after ~30 sessions with improved FRICTION_CLASSIFICATION_GUIDANCE.
  if (parsed.facets?.friction_points?.some(fp => fp.category === 'tooling-limitation')) {
    // Expanded regex covers both literal terms and GPT-4o paraphrasing patterns
    const MISCLASS_SIGNALS = /rate.?limit|throttl|quota.?exceed|crash|fail.{0,10}unexpect|lost.?state|context.{0,10}(?:drop|lost|unavail)|wrong.?tool|different.?(?:approach|method)|(?:didn.t|did not|unaware).{0,10}(?:know|capabil)|(?:older|previous).?version|used to (?:work|be)|behavio.?r.?change/i;
    const NEGATION_CONTEXT = /\bnot\b|\bnor\b|\bisn.t\b|\bwasn.t\b|\brule[d]? out\b|\brejected?\b|\beliminated?\b|\breclassif/i;
    const toolingFps = parsed.facets.friction_points.filter(fp => fp.category === 'tooling-limitation');
    for (const fp of toolingFps) {
      if (!fp._reasoning) {
        console.warn('[friction-monitor] LLM classified friction as "tooling-limitation" without _reasoning — cannot verify');
        continue;
      }
      const matchResult = fp._reasoning.match(MISCLASS_SIGNALS);
      if (matchResult) {
        // Check if the signal appears in a negation context (model correctly eliminating the alternative)
        const matchIdx = fp._reasoning.search(MISCLASS_SIGNALS);
        const preceding = fp._reasoning.slice(Math.max(0, matchIdx - 40), matchIdx);
        if (!NEGATION_CONTEXT.test(preceding)) {
          console.warn(`[friction-monitor] Likely misclassification: "tooling-limitation" with reasoning mentioning "${matchResult[0]}" — review category`);
        }
        // If negated, the model correctly considered and rejected the alternative — no warning
      } else {
        console.warn('[friction-monitor] LLM classified friction as "tooling-limitation" — verify genuine tool limitation');
      }
    }
  }

  // Observability: warn when LLM returns effective_pattern without category or driver field,
  // or with an unrecognized driver value.
  // Catches models that ignore the classification instructions (especially smaller Ollama models).
  // Remove after confirming classification quality over ~20 new sessions.
  if (parsed.facets?.effective_patterns?.some(ep => !ep.category)) {
    console.warn('[pattern-monitor] LLM returned effective_pattern without category field');
  }
  if (parsed.facets?.effective_patterns?.some(ep => !ep.driver)) {
    console.warn('[pattern-monitor] LLM returned effective_pattern without driver field — driver classification may be incomplete');
  }
  const VALID_DRIVERS = new Set(['user-driven', 'ai-driven', 'collaborative']);
  if (parsed.facets?.effective_patterns?.some(ep => ep.driver && !VALID_DRIVERS.has(ep.driver))) {
    console.warn('[pattern-monitor] LLM returned unexpected driver value — check classification quality');
  }

  // Validation: check for missing _reasoning CoT scratchpad fields.
  // These fields ensure the model walks through the attribution/driver decision trees
  // before committing to classification values.
  // (Monitoring period complete — warn calls removed after confirming CoT compliance)
  if (parsed.facets?.friction_points?.some(fp => !fp._reasoning)) {
    // Missing _reasoning: classification may lack decision-tree rigor
  }
  if (parsed.facets?.effective_patterns?.some(ep => !ep._reasoning)) {
    // Missing _reasoning: classification may lack decision-tree rigor
  }

  return { success: true, data: parsed };
}

export function parsePromptQualityResponse(response: string): ParseResult<PromptQualityResponse> {
  const response_length = response.length;
  const preview = buildResponsePreview(response);

  const jsonPayload = extractJsonPayload(response);
  if (!jsonPayload) {
    console.error('No JSON found in prompt quality response');
    return {
      success: false,
      error: { error_type: 'no_json_found', error_message: 'No JSON found in prompt quality response', response_length, response_preview: preview },
    };
  }

  const preProcessed = preProcessJson(jsonPayload);

  let parsed: PromptQualityResponse;
  try {
    parsed = JSON.parse(preProcessed) as PromptQualityResponse;
  } catch {
    try {
      const repaired = jsonrepair(preProcessed);
      parsed = JSON.parse(repaired) as PromptQualityResponse;
    } catch (err) {
      logParseErrorWithContext(preProcessed, err, 'prompt quality', response);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: { error_type: 'json_parse_error', error_message: msg, response_length, response_preview: preview },
      };
    }
  }

  if (typeof parsed.efficiency_score !== 'number') {
    console.error('Invalid prompt quality response: missing efficiency_score');
    return {
      success: false,
      error: { error_type: 'invalid_structure', error_message: 'Missing or invalid efficiency_score field', response_length, response_preview: preview },
    };
  }

  // Clamp and default
  parsed.efficiency_score = Math.max(0, Math.min(100, Math.round(parsed.efficiency_score)));
  parsed.message_overhead = parsed.message_overhead ?? 0;
  parsed.assessment = parsed.assessment || '';
  // Guard against LLM returning non-array values (e.g. "findings": "none") —
  // || [] alone won't catch truthy non-arrays, and .some() on line 166 would throw.
  parsed.takeaways = Array.isArray(parsed.takeaways) ? parsed.takeaways : [];
  parsed.findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  parsed.dimension_scores = parsed.dimension_scores || {
    context_provision: 50,
    request_specificity: 50,
    scope_management: 50,
    information_timing: 50,
    correction_quality: 50,
  };

  // Clamp dimension scores
  for (const key of Object.keys(parsed.dimension_scores) as Array<keyof PromptQualityDimensionScores>) {
    parsed.dimension_scores[key] = Math.max(0, Math.min(100, Math.round(parsed.dimension_scores[key] ?? 50)));
  }

  // Validation: check for missing category or unexpected type values in findings.
  // (Monitoring period complete — warn calls removed after confirming classification quality)
  if (parsed.findings.some(f => !f.category)) {
    // Finding missing category field
  }

  if (parsed.findings.some(f => f.type && f.type !== 'deficit' && f.type !== 'strength')) {
    // Finding has unexpected type value — expected deficit or strength
  }

  return { success: true, data: parsed };
}
