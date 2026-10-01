import { PROVIDERS } from '../constants/llm-providers.js';
import { BATCH_DISCOUNT } from './types.js';

/**
 * List price of one call, or undefined when the model has no price in the provider table.
 * Undefined (never 0) lets the pipeline tell "unpriced" from "free": a call without costUsd is
 * not counted as costed, so the pass falls back to its own pricing instead of recording a fake $0.
 */
export function listPrice(provider: string, model: string, inputTokens: number, outputTokens: number): number | undefined {
  const m = PROVIDERS.find(p => p.id === provider)?.models.find(x => x.id === model);
  if (!m || m.inputCostPer1M == null || m.outputCostPer1M == null) return undefined;
  const cost = (inputTokens / 1_000_000) * m.inputCostPer1M + (outputTokens / 1_000_000) * m.outputCostPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Batch price = list price x documented 50% discount; undefined when unpriced. */
export function batchPrice(provider: string, model: string, inputTokens: number, outputTokens: number): number | undefined {
  const list = listPrice(provider, model, inputTokens, outputTokens);
  return list === undefined ? undefined : Math.round(list * BATCH_DISCOUNT * 1_000_000) / 1_000_000;
}
