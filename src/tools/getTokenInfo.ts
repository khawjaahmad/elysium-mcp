import { z } from 'zod';
import { ToolError } from '../errors.js';
import { blockParams, parseAddress, parseBlockRef } from '../inputs.js';
import { defineTool } from './define.js';
import { blockInput, addressInput } from './schemas.js';
import { assertContract, formatTokenAmount, readOptional } from './token.js';

export const getTokenInfo = defineTool({
  name: 'get_token_info',
  title: 'Get ERC-20 token info',
  description:
    "Read an ERC-20 token's name, symbol, decimals and total supply. Fields the contract does not implement are null.",
  inputSchema: {
    token: addressInput('ERC-20 token contract address.'),
    block: blockInput('Block to read at. Defaults to latest.'),
  },
  outputSchema: {
    token: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    decimals: z.number().nullable(),
    totalSupply: z
      .object({ raw: z.string(), formatted: z.string().nullable() })
      .nullable()
      .describe("raw is in the token's smallest unit; formatted applies decimals."),
  },
  async handler({ token, block }, { client }) {
    const address = parseAddress(token, 'token');
    const at = blockParams(parseBlockRef(block));
    await assertContract(client, address, at);

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      readOptional<string>(client, address, 'name', at),
      readOptional<string>(client, address, 'symbol', at),
      readOptional<number>(client, address, 'decimals', at),
      readOptional<bigint>(client, address, 'totalSupply', at),
    ]);

    if (name === null && symbol === null && decimals === null && totalSupply === null) {
      throw new ToolError(
        'ABI_MISMATCH',
        `${address} is a contract but does not implement the ERC-20 read functions.`,
        {
          hint: 'It may be a different kind of contract (e.g. an NFT or a proxy that is not initialised). Use read_contract with its real ABI.',
          details: { address },
        },
      );
    }

    return {
      token: address,
      name,
      symbol,
      decimals,
      totalSupply:
        totalSupply === null
          ? null
          : { raw: totalSupply.toString(), formatted: formatTokenAmount(totalSupply, decimals) },
    };
  },
});
