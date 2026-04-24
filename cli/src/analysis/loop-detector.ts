import type { SQLiteMessageRow } from './prompt-types.js';

export interface RageLoopSignal {
  detected: boolean;
  confidence: number;
  reasoning: string;
  turnRange?: [string, string];
}

/**
 * Heuristically detect "Rage Loops" in a session before LLM analysis.
 * 
 * Definition: 
 * Clusters of messages within a tight temporal window where token count 
 * remains static (context maxed) and content/tool usage appears repetitive.
 */
export function detectRageLoopHeuristic(messages: SQLiteMessageRow[]): RageLoopSignal {
  if (messages.length < 5) {
    return { detected: false, confidence: 0, reasoning: 'Insufficient message count' };
  }

  const clusters: SQLiteMessageRow[][] = [];
  let currentCluster: SQLiteMessageRow[] = [];

  // Group into temporal clusters (messages within 60s of each other)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prevMsg = messages[i - 1];
    
    if (prevMsg) {
      const delta = (new Date(msg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime()) / 1000;
      if (delta < 60) {
        currentCluster.push(msg);
      } else {
        if (currentCluster.length >= 4) clusters.push([...currentCluster]);
        currentCluster = [msg];
      }
    } else {
      currentCluster.push(msg);
    }
  }
  if (currentCluster.length >= 4) clusters.push(currentCluster);

  for (const cluster of clusters) {
    // Check for static high token count
    const tokens = cluster.map(m => {
      try {
        const usage = JSON.parse(m.usage || '{}');
        return usage.inputTokens || usage.totalTokens || 0;
      } catch {
        return 0;
      }
    }).filter(t => t > 50000); // Only care about large contexts

    if (tokens.length < 4) continue;

    // Static if max deviance is < 2%
    const avg = tokens.reduce((a, b) => a + b, 0) / tokens.length;
    const isStatic = tokens.every(t => Math.abs(t - avg) / avg < 0.02);

    if (isStatic) {
      // Check for semantic repetition (simple check: repeating tool calls or content fragments)
      const repetitions = cluster.filter((m, i) => {
        if (i === 0) return false;
        const prev = cluster[i - 1];
        return m.content.slice(0, 100) === prev.content.slice(0, 100) || 
               m.tool_calls === prev.tool_calls;
      });

      if (repetitions.length >= 2) {
        const firstTurn = messages.indexOf(cluster[0]);
        const lastTurn = messages.indexOf(cluster[cluster.length - 1]);
        
        return {
          detected: true,
          confidence: 0.85,
          reasoning: `Detected ${cluster.length} messages in ${Math.round((new Date(cluster[cluster.length-1].timestamp).getTime() - new Date(cluster[0].timestamp).getTime())/1000)}s with static token count (${Math.round(avg/1000)}k) and repetitive signals.`,
          turnRange: [`Turn#${firstTurn}`, `Turn#${lastTurn}`]
        };
      }
    }
  }

  return { detected: false, confidence: 0, reasoning: 'No loop patterns detected' };
}
