import { z } from 'zod';
import { isoTimestamp, jsonSafeObject } from '../format.js';
import { parseBlockRef } from '../inputs.js';
import { defineTool } from './define.js';

export const getBlock = defineTool({
  name: 'get_block',
  title: 'Get block',
  description:
    'Fetch a block by number, hash or tag. Returns header fields and transaction hashes (or full transactions).',
  inputSchema: {
    block: z
      .union([z.number().int().nonnegative(), z.string()])
      .optional()
      .describe(
        'Block number, 32-byte block hash, or tag (latest, safe, finalized, earliest, pending). Defaults to latest.',
      ),
    includeTransactions: z
      .boolean()
      .optional()
      .describe('Return full transaction objects instead of hashes. Defaults to false.'),
  },
  outputSchema: {
    block: z
      .record(z.string(), z.unknown())
      .describe(
        'Block fields as returned by the node. Integers are decimal strings. Arbitrum-specific fields (e.g. l1BlockNumber, sendRoot) are passed through.',
      ),
    timestampIso: z.string(),
    transactionCount: z.number(),
  },
  async handler({ block, includeTransactions }, { client }) {
    const ref = parseBlockRef(block, { allowHash: true });
    const result = await client.getBlock({ ...ref, includeTransactions: includeTransactions ?? false });
    return {
      block: jsonSafeObject(result),
      timestampIso: isoTimestamp(result.timestamp),
      transactionCount: result.transactions.length,
    };
  },
});
