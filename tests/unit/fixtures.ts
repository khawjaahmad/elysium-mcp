import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { RpcFailure } from './helpers/rpc.js';

export const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'error InsufficientBalance(uint256 available, uint256 required)',
]);

export const SELECTOR = {
  name: toFunctionSelector('name()'),
  symbol: toFunctionSelector('symbol()'),
  decimals: toFunctionSelector('decimals()'),
  totalSupply: toFunctionSelector('totalSupply()'),
  balanceOf: toFunctionSelector('balanceOf(address)'),
  transfer: toFunctionSelector('transfer(address,uint256)'),
};

/** eth_call params[0].data, regardless of which call shape viem sent. */
export function callData(params: unknown[]): Hex {
  return ((params[0] as { data?: Hex; input?: Hex }).data ?? (params[0] as { input?: Hex }).input ?? '0x') as Hex;
}

/** A mock ERC-20 answering eth_call by selector. Pass `undefined` for a function to make it revert. */
export function erc20Handler(values: {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  balance?: bigint;
}) {
  return (params: unknown[]) => {
    const data = callData(params);
    const selector = data.slice(0, 10);
    const respond = <N extends 'name' | 'symbol' | 'decimals' | 'totalSupply' | 'balanceOf'>(fn: N, value: unknown) => {
      if (value === undefined) throw new RpcFailure(3, 'execution reverted', '0x');
      return encodeFunctionResult({ abi: ERC20, functionName: fn, result: value as never });
    };
    if (selector === SELECTOR.name) return respond('name', values.name);
    if (selector === SELECTOR.symbol) return respond('symbol', values.symbol);
    if (selector === SELECTOR.decimals) return respond('decimals', values.decimals);
    if (selector === SELECTOR.totalSupply) return respond('totalSupply', values.totalSupply);
    if (selector === SELECTOR.balanceOf) return respond('balanceOf', values.balance);
    throw new RpcFailure(3, 'execution reverted', '0x');
  };
}

export function revertWith(reason: string): RpcFailure {
  const data = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: [reason] });
  return new RpcFailure(3, `execution reverted: ${reason}`, data);
}

export function transferLog(from: Hex, to: Hex, value: bigint, overrides: Record<string, unknown> = {}) {
  return {
    address: '0x3333333333333333333333333333333333333333',
    topics: encodeEventTopics({ abi: ERC20, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: '0x64',
    blockHash: `0xb${'0'.repeat(61)}64`,
    transactionHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: '0x1',
    logIndex: '0x0',
    removed: false,
    ...overrides,
  };
}
