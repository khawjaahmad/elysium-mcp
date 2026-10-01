import { z } from 'zod';
import { gasPrice, isoTimestamp } from '../format.js';
import { defineTool } from './define.js';
import { gasPriceSchema } from './schemas.js';

export const getChainStatus = defineTool({
  name: 'get_chain_status',
  title: 'Get chain status',
  description:
    'Latest block, measured average block time, current base fee and gas price. ' +
    'Block timestamps have one-second resolution while Elysium produces several blocks per second, ' +
    'so block time is measured over a window of recent blocks.',
  inputSchema: {
    sampleSize: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe('How many recent blocks to measure block time over. Defaults to BLOCK_TIME_SAMPLE_SIZE (1000).'),
  },
  outputSchema: {
    chainId: z.number(),
    chainName: z.string(),
    latestBlock: z.object({
      number: z.string(),
      hash: z.string().nullable(),
      timestamp: z.string().describe('Unix seconds.'),
      timestampIso: z.string(),
      transactionCount: z.number(),
      gasUsed: z.string(),
      gasLimit: z.string(),
    }),
    baseFeePerGas: gasPriceSchema.nullable().describe('Minimum per-gas fee for the next block, from the latest block.'),
    gasPrice: gasPriceSchema.describe('Node-suggested gas price (eth_gasPrice).'),
    blockTime: z.object({
      averageMs: z.number().nullable().describe('null if all sampled blocks share one timestamp second.'),
      sampleBlocks: z.number(),
      windowSeconds: z.number(),
      fromBlock: z.string(),
      toBlock: z.string(),
    }),
  },
  async handler({ sampleSize }, { client, config }) {
    const [latest, price] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getGasPrice()]);
    if (latest.number === null) throw new Error('Latest block has no number');

    const span = BigInt(sampleSize ?? config.blockTimeSampleSize);
    const fromNumber = latest.number > span ? latest.number - span : 0n;
    const earlier = fromNumber === latest.number ? latest : await client.getBlock({ blockNumber: fromNumber });

    const blocks = Number(latest.number - fromNumber);
    const seconds = Number(latest.timestamp - earlier.timestamp);
    const averageMs = blocks > 0 && seconds > 0 ? Math.round(((seconds * 1000) / blocks) * 10) / 10 : null;

    return {
      chainId: config.chainId,
      chainName: config.chainName,
      latestBlock: {
        number: latest.number.toString(),
        hash: latest.hash,
        timestamp: latest.timestamp.toString(),
        timestampIso: isoTimestamp(latest.timestamp),
        transactionCount: latest.transactions.length,
        gasUsed: latest.gasUsed.toString(),
        gasLimit: latest.gasLimit.toString(),
      },
      baseFeePerGas: latest.baseFeePerGas == null ? null : gasPrice(latest.baseFeePerGas),
      gasPrice: gasPrice(price),
      blockTime: {
        averageMs,
        sampleBlocks: blocks,
        windowSeconds: seconds,
        fromBlock: fromNumber.toString(),
        toBlock: latest.number.toString(),
      },
    };
  },
});
