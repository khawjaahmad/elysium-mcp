import { numberToHex } from 'viem';

/** Thrown by a handler to make the mock node answer with a JSON-RPC error. */
export class RpcFailure {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: string,
  ) {}
}

/** Returned by a handler to make the mock node answer with a bare HTTP status. */
export class HttpFailure {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string> = {},
  ) {}
}

/** Returned by a handler to make the request hang until aborted (simulates a timeout). */
export const HANG = Symbol('hang');

export type Handler = (params: unknown[]) => unknown;

export interface RpcCall {
  method: string;
  params: unknown[];
}

export const TESTNET_CHAIN_ID = 99801;

/**
 * A fake JSON-RPC node behind `fetch`. Unmocked methods answer -32601.
 * eth_chainId answers the testnet chain ID unless overridden.
 */
export function mockRpc(handlers: Record<string, Handler>) {
  const calls: RpcCall[] = [];
  const all: Record<string, Handler> = { eth_chainId: () => numberToHex(TESTNET_CHAIN_ID), ...handlers };

  const fetchFn = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const params = body.params ?? [];
    calls.push({ method: body.method, params });
    const reply = (payload: object) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const handler = all[body.method];
    if (!handler) return reply({ error: { code: -32601, message: `the method ${body.method} does not exist` } });
    try {
      const result = await handler(params);
      if (result === HANG) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        });
      }
      if (result instanceof HttpFailure) {
        return new Response('upstream error', { status: result.status, headers: result.headers });
      }
      return reply({ result });
    } catch (err) {
      if (err instanceof RpcFailure) {
        return reply({ error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } });
      }
      throw err;
    }
  };

  return {
    fetchFn: fetchFn as typeof fetch,
    calls,
    count: (method: string) => calls.filter((c) => c.method === method).length,
  };
}

// ---- RPC-format fixtures ----------------------------------------------------

const ZERO_HASH = `0x${'0'.repeat(64)}`;
/** Deterministic 32-byte hash for block `n`. */
export const hashOf = (n: number | bigint) => `0xb${BigInt(n).toString(16).padStart(63, '0')}` as const;

export function rpcBlock(
  number: number | bigint,
  timestamp: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: numberToHex(BigInt(number)),
    hash: hashOf(number),
    parentHash: number === 0 ? ZERO_HASH : hashOf(BigInt(number) - 1n),
    timestamp: numberToHex(timestamp),
    gasUsed: '0x1c1a6',
    gasLimit: '0x4000000000000',
    baseFeePerGas: '0x989680', // 10,000,000 wei = 0.01 gwei
    miner: '0xa4b000000000000000000073657175656e636572',
    nonce: '0x0000000000000001',
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: ZERO_HASH,
    logsBloom: `0x${'0'.repeat(512)}`,
    mixHash: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    stateRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    size: '0x3c6',
    uncles: [],
    transactions: [],
    l1BlockNumber: '0x100',
    sendCount: '0x0',
    sendRoot: ZERO_HASH,
    ...overrides,
  };
}

export const ALICE = '0x1111111111111111111111111111111111111111';
export const BOB = '0x2222222222222222222222222222222222222222';
export const TOKEN = '0x3333333333333333333333333333333333333333';
export const TX_HASH = `0x${'ab'.repeat(32)}`;

export function rpcTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: TX_HASH,
    from: ALICE,
    to: TOKEN,
    value: '0x0',
    input: '0x',
    gas: '0x30d40',
    gasPrice: '0x989680',
    maxFeePerGas: '0x1312d00',
    maxPriorityFeePerGas: '0x0',
    nonce: '0x7',
    blockHash: hashOf(100),
    blockNumber: '0x64',
    transactionIndex: '0x1',
    type: '0x2',
    chainId: numberToHex(TESTNET_CHAIN_ID),
    accessList: [],
    v: '0x0',
    yParity: '0x0',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'2'.repeat(64)}`,
    ...overrides,
  };
}

export function rpcReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: TX_HASH,
    transactionIndex: '0x1',
    blockHash: hashOf(100),
    blockNumber: '0x64',
    from: ALICE,
    to: TOKEN,
    gasUsed: '0x5208', // 21000
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x989680', // 0.01 gwei
    status: '0x1',
    type: '0x2',
    contractAddress: null,
    logsBloom: `0x${'0'.repeat(512)}`,
    logs: [],
    gasUsedForL1: '0x0',
    l1BlockNumber: '0x100',
    ...overrides,
  };
}
