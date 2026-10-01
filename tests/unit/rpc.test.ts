import { createPublicClient, HttpRequestError, TimeoutError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { ToolError } from '../../src/errors.js';
import { ChainGuard, RateLimiter, resilientHttp, withRetry } from '../../src/rpc.js';
import { testConfig } from './helpers/harness.js';
import { HttpFailure, mockRpc, RpcFailure } from './helpers/rpc.js';

/** A controllable clock: sleep advances time instantly and records the delay. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

describe('RateLimiter', () => {
  it('allows a burst up to the rate, then spaces requests evenly', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.sleeps.map(Math.round)).toEqual([100, 100]);
  });

  it('queues concurrent callers in order instead of letting them all through', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      2,
      () => now,
      async (ms) => void waits.push(ms),
    );
    await Promise.all([1, 2, 3, 4, 5].map(() => limiter.acquire()));
    // 2 immediate, then reservations at 0.5s, 1.0s, 1.5s.
    expect(waits.map(Math.round)).toEqual([500, 1000, 1500]);
    now = 10_000;
    waits.length = 0;
    await limiter.acquire();
    expect(waits).toEqual([]);
  });

  it('rejects a non-positive rate', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError);
  });
});

describe('withRetry', () => {
  const timeout = () => new TimeoutError({ body: {}, url: 'http://x' });

  it('retries retryable errors with exponential backoff and full jitter', async () => {
    const clock = fakeClock();
    const fn = vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockResolvedValue('ok');
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 100, sleep: clock.sleep, random: () => 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const clock = fakeClock();
    const fn = vi.fn().mockRejectedValue(timeout());
    await expect(
      withRetry(fn, { retries: 4, baseDelayMs: 1000, maxDelayMs: 2500, sleep: clock.sleep, random: () => 1 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(clock.sleeps).toEqual([1000, 2000, 2500, 2500]);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('execution reverted'));
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1, sleep: async () => {} })).rejects.toThrow('reverted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429 responses', async () => {
    const clock = fakeClock();
    const rateLimited = new HttpRequestError({
      url: 'http://x',
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue('ok');
    await withRetry(fn, { retries: 1, baseDelayMs: 1, sleep: clock.sleep });
    expect(clock.sleeps).toEqual([2000]);
  });
});

describe('resilientHttp', () => {
  const config = testConfig({ rpcRetryCount: 3, rpcRetryBaseDelayMs: 1, rpcTimeoutMs: 50 });

  function clientFor(handlers: Parameters<typeof mockRpc>[0], limiter = new RateLimiter(1000)) {
    const rpc = mockRpc(handlers);
    const client = createPublicClient({
      chain: buildChain(config),
      transport: resilientHttp(config, { limiter, fetchFn: rpc.fetchFn, sleep: async () => {} }),
    });
    return { client, rpc };
  }

  it('retries 5xx and 429 responses, then succeeds', async () => {
    let n = 0;
    const { client, rpc } = clientFor({
      eth_blockNumber: () => (++n === 1 ? new HttpFailure(502) : n === 2 ? new HttpFailure(429) : '0x10'),
    });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(rpc.count('eth_blockNumber')).toBe(3);
  });

  it('does not retry JSON-RPC errors such as reverts or bad params', async () => {
    const { client, rpc } = clientFor({
      eth_blockNumber: () => {
        throw new RpcFailure(-32602, 'invalid params');
      },
    });
    await expect(client.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(rpc.count('eth_blockNumber')).toBe(1);
  });

  it('does not retry HTTP 4xx other than 408/429', async () => {
    const { client, rpc } = clientFor({ eth_blockNumber: () => new HttpFailure(401) });
    await expect(client.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(rpc.count('eth_blockNumber')).toBe(1);
  });

  it('sends every attempt, including retries, through the rate limiter', async () => {
    const limiter = new RateLimiter(1000);
    const acquire = vi.spyOn(limiter, 'acquire');
    let n = 0;
    const { client } = clientFor({ eth_blockNumber: () => (++n < 3 ? new HttpFailure(503) : '0x1') }, limiter);
    await client.getBlockNumber({ cacheTime: 0 });
    expect(acquire).toHaveBeenCalledTimes(3);
  });
});

describe('ChainGuard', () => {
  it('verifies once and caches success', async () => {
    const getChainId = vi.fn().mockResolvedValue(99801);
    const guard = new ChainGuard({ getChainId }, 99801);
    await guard.ensure();
    await guard.ensure();
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight check between concurrent callers', async () => {
    const getChainId = vi.fn().mockResolvedValue(99801);
    const guard = new ChainGuard({ getChainId }, 99801);
    await Promise.all([guard.ensure(), guard.ensure(), guard.ensure()]);
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  it('retries after a network failure instead of caching it', async () => {
    const getChainId = vi
      .fn()
      .mockRejectedValueOnce(new TimeoutError({ body: {}, url: 'http://x' }))
      .mockResolvedValue(99801);
    const guard = new ChainGuard({ getChainId }, 99801);
    await expect(guard.ensure()).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    await expect(guard.ensure()).resolves.toBeUndefined();
  });

  it('fails with CHAIN_MISMATCH for the wrong chain', async () => {
    const guard = new ChainGuard({ getChainId: async () => 1 }, 99801);
    const err = await guard.ensure().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: 'CHAIN_MISMATCH' });
  });
});
