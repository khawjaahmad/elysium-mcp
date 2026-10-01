import { BlockNotFoundError, HttpRequestError, InvalidAddressError, RpcRequestError, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';
import { ToolError, toToolError } from '../../src/errors.js';

const rpcError = (code: number, message: string, data?: string) =>
  new RpcRequestError({ body: {}, url: 'http://x', error: { code, message, ...(data ? { data } : {}) } });

describe('toToolError', () => {
  it.each([
    ['timeout', new TimeoutError({ body: {}, url: 'http://x' }), 'RPC_TIMEOUT', true],
    ['HTTP 429', new HttpRequestError({ url: 'http://x', status: 429 }), 'RATE_LIMITED', true],
    ['HTTP 503', new HttpRequestError({ url: 'http://x', status: 503 }), 'RPC_UNAVAILABLE', true],
    ['connection refused', new HttpRequestError({ url: 'http://x', details: 'fetch failed' }), 'RPC_UNAVAILABLE', true],
    ['HTTP 401', new HttpRequestError({ url: 'http://x', status: 401 }), 'RPC_ERROR', false],
    ['JSON-RPC rate limit', rpcError(-32005, 'rate limit exceeded'), 'RATE_LIMITED', true],
    ['JSON-RPC limit (not rate)', rpcError(-32005, 'query exceeds max results'), 'RPC_ERROR', false],
    ['revert', rpcError(3, 'execution reverted: nope', '0x'), 'EXECUTION_REVERTED', false],
    ['generic node error', rpcError(-32000, 'header not found'), 'RPC_ERROR', false],
    ['bad address', new InvalidAddressError({ address: '0x1' }), 'INVALID_ADDRESS', false],
    ['missing block', new BlockNotFoundError({ blockNumber: 1n }), 'NOT_FOUND', false],
    ['unknown', new Error('boom'), 'INTERNAL_ERROR', false],
  ])('%s -> %s', (_label, err, code, retryable) => {
    const result = toToolError(err);
    expect(result.code).toBe(code);
    expect(result.retryable).toBe(retryable);
  });

  it('keeps the node message for RPC errors', () => {
    expect(toToolError(rpcError(-32000, 'header not found')).message).toContain('header not found');
  });

  it('passes ToolErrors through untouched and serialises them', () => {
    const original = new ToolError('RANGE_TOO_LARGE', 'too big', { hint: 'split', details: { max: '10' } });
    expect(toToolError(original)).toBe(original);
    expect(original.toJSON()).toEqual({
      code: 'RANGE_TOO_LARGE',
      message: 'too big',
      retryable: false,
      hint: 'split',
      details: { max: '10' },
    });
  });
});
