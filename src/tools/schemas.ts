import { z } from 'zod';

// ---- Input fragments -------------------------------------------------------
// Inputs are kept to plain JSON types here; semantic checks (checksums, hex,
// ABI shape) happen in the handlers so failures come back as typed errors.

export const addressInput = (description: string) =>
  z.string().describe(`${description} 0x followed by 40 hex characters.`);

export const blockInput = (description: string) =>
  z
    .union([z.number().int().nonnegative(), z.string()])
    .optional()
    .describe(`${description} An integer block number or a tag: latest, safe, finalized, earliest, pending.`);

export const abiInput = (description: string) =>
  z
    .union([
      z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
      z.record(z.string(), z.unknown()),
      z.string(),
    ])
    .describe(
      `${description} Either a JSON ABI (array of items, or a single item), or human-readable signatures such as ` +
        '["function balanceOf(address owner) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"].',
    );

export const argsInput = z
  .array(z.unknown())
  .optional()
  .describe(
    'Function arguments in order. Integers may be numbers or decimal/0x-hex strings (use strings above 2^53). ' +
      'Tuples may be arrays or objects keyed by component name.',
  );

// ---- Output fragments ------------------------------------------------------

export const nativeAmountSchema = z.object({
  wei: z.string().describe('Amount in wei (the smallest unit), as a decimal string.'),
  formatted: z.string().describe('Amount in whole coins, e.g. "1.5".'),
  symbol: z.string(),
});

export const gasPriceSchema = z.object({
  wei: z.string(),
  gwei: z.string(),
});

export const decodedLogSchema = z.object({
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
  blockNumber: z.string().nullable(),
  blockHash: z.string().nullable(),
  transactionHash: z.string().nullable(),
  transactionIndex: z.number().nullable(),
  logIndex: z.number().nullable(),
  removed: z.boolean(),
  decoded: z
    .object({ eventName: z.string(), args: z.unknown() })
    .nullable()
    .describe('Present when an ABI was supplied and it contains this event; null otherwise.'),
  decodeError: z.string().optional().describe('Why decoding failed, if the event matched but its data did not.'),
});

export const revertSchema = z.object({
  reason: z.string().nullable(),
  data: z.string().nullable(),
  errorName: z.string().nullable(),
  errorArgs: z.array(z.unknown()).nullable(),
});
