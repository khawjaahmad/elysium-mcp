import {
  createPublicClient,
  http,
  HttpRequestError,
  BaseError,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import type { Config } from './config.js';
import { isRetryableTransportError, ToolError, toToolError } from './errors.js';
import type { Logger } from './logger.js';

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Token-bucket rate limiter. Holds up to `ratePerSecond` tokens and refills
 * continuously. When empty, callers reserve a future token and wait for it,
 * so concurrent callers are served in order without busy-waiting.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    if (!(ratePerSecond > 0)) throw new RangeError('ratePerSecond must be > 0');
    this.capacity = Math.max(1, ratePerSecond);
    this.tokens = this.capacity;
    this.lastRefill = now();
  }

  async acquire(): Promise<void> {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.lastRefill) / 1000) * this.ratePerSecond);
    this.lastRefill = t;
    this.tokens -= 1;
    if (this.tokens >= 0) return;
    await this.sleep((-this.tokens / this.ratePerSecond) * 1000);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: Sleep;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Retry-After header in milliseconds, if the error carries one. */
function retryAfterMs(err: unknown): number | undefined {
  const http =
    err instanceof BaseError ? (err.walk((e) => e instanceof HttpRequestError) as HttpRequestError | null) : null;
  const value = http?.headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Runs `fn`, retrying retryable failures with exponential backoff and full
 * jitter: delay = random(0, min(maxDelay, base * 2^attempt)). A Retry-After
 * header from the server takes precedence (capped at maxDelay).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    baseDelayMs,
    maxDelayMs = 10_000,
    isRetryable = isRetryableTransportError,
    sleep = realSleep,
    random = Math.random,
    onRetry,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.min(maxDelayMs, retryAfterMs(err) ?? Math.round(random() * backoff));
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}

export interface TransportDeps {
  limiter: RateLimiter;
  logger?: Logger;
  sleep?: Sleep;
  fetchFn?: typeof fetch;
}

/**
 * viem HTTP transport with our own retry policy and rate limiting. viem's
 * built-in retry is disabled so that every attempt (including retries) goes
 * through the rate limiter, and only transport failures (timeouts, 408/429/5xx,
 * connection errors) are retried, never reverts or bad-input errors.
 */
export function resilientHttp(
  config: Pick<Config, 'rpcUrl' | 'rpcTimeoutMs' | 'rpcRetryCount' | 'rpcRetryBaseDelayMs'>,
  deps: TransportDeps,
): Transport {
  const base = http(config.rpcUrl, {
    timeout: config.rpcTimeoutMs,
    retryCount: 0,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });

  return (params) => {
    const inner = base({ ...params, retryCount: 0 });
    return {
      ...inner,
      request: (args, options) =>
        withRetry(
          async () => {
            // Acquire outside viem's timeout window so queueing never counts as an RPC timeout.
            await deps.limiter.acquire();
            return inner.request(args, options);
          },
          {
            retries: config.rpcRetryCount,
            baseDelayMs: config.rpcRetryBaseDelayMs,
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
            onRetry: ({ attempt, delayMs, error }) =>
              deps.logger?.warn(
                `RPC ${args.method} failed (${toToolError(error).code}); retry ${attempt} in ${delayMs} ms`,
              ),
          },
        ),
    } as ReturnType<Transport>;
  };
}

export function createElysiumClient(config: Config, chain: Chain, deps: TransportDeps): PublicClient {
  return createPublicClient({ chain, transport: resilientHttp(config, deps) });
}

/** The subset of viem's PublicClient the tools use. Unit tests mock this. */
export type ChainClient = Pick<
  PublicClient,
  | 'chain'
  | 'getChainId'
  | 'getBlock'
  | 'getBlockNumber'
  | 'getGasPrice'
  | 'getTransaction'
  | 'getTransactionReceipt'
  | 'getBalance'
  | 'getCode'
  | 'readContract'
  | 'call'
  | 'estimateGas'
  | 'request'
>;

/**
 * Checks once that the RPC endpoint serves the configured chain ID. A
 * mismatch is permanent; a network failure is not cached, so the next tool
 * call tries again.
 */
export class ChainGuard {
  private pending: Promise<void> | undefined;
  private verified = false;

  constructor(
    private readonly client: Pick<ChainClient, 'getChainId'>,
    private readonly expectedChainId: number,
  ) {}

  async ensure(): Promise<void> {
    if (this.verified) return;
    this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async check(): Promise<void> {
    let actual: number;
    try {
      actual = await this.client.getChainId();
    } catch (err) {
      throw toToolError(err);
    }
    if (actual !== this.expectedChainId) {
      throw new ToolError(
        'CHAIN_MISMATCH',
        `The RPC endpoint serves chain ID ${actual}, but ELYSIUM_CHAIN_ID is ${this.expectedChainId}.`,
        {
          hint: 'Fix ELYSIUM_RPC_URL or ELYSIUM_CHAIN_ID and restart the server.',
          details: { expected: this.expectedChainId, actual },
        },
      );
    }
    this.verified = true;
  }
}
