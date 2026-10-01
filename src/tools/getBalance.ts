import type { Address, BlockTag } from 'viem';
import { z } from 'zod';
import { toToolError } from '../errors.js';
import { ERC20_ABI } from '../erc20.js';
import { nativeAmount } from '../format.js';
import { blockParams, parseAddress, parseBlockRef } from '../inputs.js';
import type { ChainClient } from '../rpc.js';
import { defineTool } from './define.js';
import { addressInput, blockInput, nativeAmountSchema } from './schemas.js';
import { assertContract, formatTokenAmount, readOptional } from './token.js';

const MAX_TOKENS = 20;

const tokenBalanceSchema = z.union([
  z.object({
    token: z.string(),
    symbol: z.string().nullable(),
    decimals: z.number().nullable(),
    raw: z.string().describe("Balance in the token's smallest unit."),
    formatted: z.string().nullable().describe('Balance with decimals applied; null if decimals() is not implemented.'),
  }),
  z.object({
    token: z.string(),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), hint: z.string().optional() }),
  }),
]);

type BlockParams = { blockNumber: bigint } | { blockTag: BlockTag };

async function tokenBalance(client: ChainClient, owner: Address, token: Address, at: BlockParams) {
  try {
    await assertContract(client, token, at);
    const [raw, decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner], ...at }),
      readOptional<number>(client, token, 'decimals', at),
      readOptional<string>(client, token, 'symbol', at),
    ]);
    return { token, symbol, decimals, raw: raw.toString(), formatted: formatTokenAmount(raw, decimals) };
  } catch (err) {
    const { code, message, retryable, hint } = toToolError(err).toJSON();
    return { token, error: { code, message, retryable, ...(hint ? { hint } : {}) } };
  }
}

export const getBalance = defineTool({
  name: 'get_balance',
  title: 'Get balance',
  description:
    "Native HYPE balance of an address, plus optional ERC-20 balances. A failure for one token is reported in that token's entry and does not fail the whole call.",
  inputSchema: {
    address: addressInput('Account or contract whose balances to read.'),
    tokens: z
      .array(z.string())
      .max(MAX_TOKENS)
      .optional()
      .describe(`ERC-20 token contract addresses to read balances for (max ${MAX_TOKENS}).`),
    block: blockInput('Block to read at. Defaults to latest.'),
  },
  outputSchema: {
    address: z.string(),
    native: nativeAmountSchema,
    tokens: z.array(tokenBalanceSchema),
  },
  async handler({ address, tokens, block }, { client }) {
    const owner = parseAddress(address);
    const at = blockParams(parseBlockRef(block));
    const tokenAddresses = [...new Set((tokens ?? []).map((t, i) => parseAddress(t, `tokens[${i}]`)))];

    const [native, tokenResults] = await Promise.all([
      client.getBalance({ address: owner, ...at }),
      Promise.all(tokenAddresses.map((token) => tokenBalance(client, owner, token, at))),
    ]);

    return { address: owner, native: nativeAmount(client.chain, native), tokens: tokenResults };
  },
});
