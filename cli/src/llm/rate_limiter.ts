// Token bucket rate limiter for server-side LLM API throttling (2-4 RPM)

import type { LLMProvider } from './types.js';

/**
 * Token bucket rate limiter.
 * Allows bursts up to `capacity` tokens, then refills gradually to maintain
 * the configured requests-per-minute (RPM) average.
 *
 * Usage:
 *   const limiter = new RateLimiter(rpm);
 *   await limiter.acquire(); // waits if no tokens available
 */
export class RateLimiter {
  private tokens: number;
  private lastUpdate: number;
  private readonly rpm: number;
  private readonly capacity: number;
  private readonly refillInterval: number; // ms per token

  constructor(rpm: number) {
    this.rpm = rpm;
    this.capacity = Math.max(1, Math.floor(rpm)); // burst capacity = RPM limit
    this.tokens = this.capacity;
    this.lastUpdate = Date.now();

    // Gradual refill: 60,000 ms / rpm tokens = ms per token
    this.refillInterval = 60000 / rpm;
  }

  /** Add tokens based on elapsed time, return true if acquire succeeds */
  private refill(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastUpdate;
    const newTokens = elapsed / this.refillInterval;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastUpdate = now;
    return this.tokens >= 1;
  }

  /**
   * Attempt to acquire one token.
   * Returns true immediately if a token is available.
   * Returns false if no tokens are available (caller should retry later).
   */
  tryAcquire(): boolean {
    if (this.refill() && this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Acquire one token, waiting (with exponential backoff) until one is available.
   * Throws if interrupted.
   */
  async acquire(options?: { signal?: AbortSignal; maxWaitMs?: number }): Promise<void> {
    const { signal, maxWaitMs = 30000 } = options || {};

    const start = Date.now();
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (this.tryAcquire()) {
        return;
      }
      if (maxWaitMs > 0 && Date.now() - start >= maxWaitMs) {
        throw new Error('RateLimiter acquire timeout');
      }
      // Exponential-ish backoff: wait 100ms, 200ms, 400ms... but capped
      const wait = Math.min(100 * Math.pow(2, Math.floor((Date.now() - start) / 200)), 1000);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }

  /** Return current token count (0..capacity) */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Singleton rate limiter, lazily created from config.
 * Only created when a valid RPM (2-4) is configured.
 */
let rateLimiter: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter | null {
  if (rateLimiter !== null) {
    return rateLimiter;
  }
  // Lazy init — in server this would read from loadLLMConfig() at runtime
  // For now, keep null by default; tests/mocks will set up as needed.
  return null;
}

/**
 * Create and set a rate limiter (used by tests or runtime config).
 */
export function setRateLimiter(rpm: number): RateLimiter {
  if (rpm < 2 || rpm > 4) {
    throw new Error(`RateLimiter RPM must be 2-4, got ${rpm}`);
  }
  rateLimiter = new RateLimiter(rpm);
  return rateLimiter;
}

/**
 * Reset the singleton (useful in tests).
 */
export function resetRateLimiter(): void {
  rateLimiter = null;
}