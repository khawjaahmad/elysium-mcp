import { formatUnits, type Address, type BlockTag } from 'viem';
import { ToolError, toToolError } from '../errors.js';
import { ERC20_ABI } from '../erc20.js';
import type { ChainClient } from '../rpc.js';

type BlockParams = { blockNumber: bigint } | { blockTag: BlockTag };

/** Fails with NOT_A_CONTRACT if no code is deployed at `address`. */
export async function assertContract(client: ChainClient, address: Address, block: BlockParams): Promise<void> {
  const code = await client.getCode({ address, ...block });
  if (code === undefined || code === '0x') {
    throw new ToolError('NOT_A_CONTRACT', `No contract code is deployed at ${address}.`, {
      hint: 'Check the address and that it is on this network. Regular accounts (EOAs) have no code.',
      details: { address },
    });
  }
}

/**
 * Reads one ERC-20 view function. Returns null if the contract does not
 * implement it (revert or empty/undecodable data); rethrows transport errors
 * so an RPC outage is never mistaken for "not a token".
 */
export async function readOptional<T>(
  client: ChainClient,
  address: Address,
  functionName: 'name' | 'symbol' | 'decimals' | 'totalSupply',
  block: BlockParams,
): Promise<T | null> {
  try {
    return (await client.readContract({ address, abi: ERC20_ABI, functionName, ...block })) as T;
  } catch (err) {
    const e = toToolError(err);
    if (e.code === 'ABI_MISMATCH' || e.code === 'EXECUTION_REVERTED' || e.code === 'INVALID_INPUT') return null;
    throw e;
  }
}

export function formatTokenAmount(raw: bigint, decimals: number | null): string | null {
  return decimals === null ? null : formatUnits(raw, decimals);
}
