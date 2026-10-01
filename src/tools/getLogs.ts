import { encodeEventTopics, formatLog, numberToHex, type AbiEvent, type Address, type Hex, type RpcLog } from 'viem';
import { z } from 'zod';
import { ToolError, rpcMessage, toToolError } from '../errors.js';
import { coerceArg, parseAbiInput, parseAddress, parseBlockRef, parseHex } from '../inputs.js';
import type { ChainClient } from '../rpc.js';
import { defineTool } from './define.js';
import { shapeLog } from './logs.js';
import { abiInput, decodedLogSchema } from './schemas.js';

const MAX_ADDRESSES = 20;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

/** Messages nodes use when a log query spans too much. Matched case-insensitively. */
const RANGE_ERROR_PATTERN =
  /block range|range (is )?too (large|wide|big)|too many (blocks|results|logs)|exceed(s|ed)? .*(limit|range|max)|limit exceeded|more than \d+ (results|logs|blocks)|query returned more than|response size/i;

async function resolveBlockNumber(
  client: ChainClient,
  value: number | string | undefined,
  field: string,
  latest: () => Promise<bigint>,
) {
  const ref = parseBlockRef(value, { field });
  if ('blockNumber' in ref) return ref.blockNumber;
  if ('blockTag' in ref && ref.blockTag === 'earliest') return 0n;
  if ('blockTag' in ref && ref.blockTag === 'latest') return latest();
  // safe / finalized / pending: ask the node which block that is.
  const block = await client.getBlock({ blockTag: (ref as { blockTag: 'safe' | 'finalized' | 'pending' }).blockTag });
  if (block.number === null) throw new ToolError('NOT_FOUND', `The node has no ${field} block number for that tag.`);
  return block.number;
}

/**
 * Validates and coerces indexed-argument filters. Keys must name indexed
 * parameters; a list means "any of"; null means "any value".
 */
function indexedArgs(event: AbiEvent, args: Record<string, unknown>): Record<string, unknown> {
  const indexed = event.inputs.filter((p) => p.indexed && p.name);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const param = indexed.find((p) => p.name === key);
    if (!param) {
      throw new ToolError('INVALID_INPUT', `"${key}" is not an indexed parameter of ${event.name}.`, {
        hint: indexed.length
          ? `Indexed parameters: ${indexed.map((p) => p.name).join(', ')}. Only these can be filtered on.`
          : `${event.name} has no named indexed parameters; use raw topics instead.`,
      });
    }
    const path = `args.${key}`;
    if (value === null) out[key] = null;
    else if (Array.isArray(value) && !param.type.endsWith(']'))
      out[key] = value.map((v, i) => coerceArg(param, v, `${path}[${i}]`));
    else out[key] = coerceArg(param, value, path);
  }
  return out;
}

/** A topic is always exactly 32 bytes. */
function topic(value: string, field: string): Hex {
  const hex = parseHex(value, field);
  if (hex.length !== 66) {
    throw new ToolError('INVALID_INPUT', `${field} must be 32 bytes (0x followed by 64 hex characters).`, {
      hint: 'Addresses used as topics are left-padded with zeros to 32 bytes.',
      details: { field },
    });
  }
  return hex;
}

function topicInput(value: string | string[] | null, index: number): Hex | Hex[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v, j) => topic(v, `topics[${index}][${j}]`));
  return topic(value, `topics[${index}]`);
}

export const getLogs = defineTool({
  name: 'get_logs',
  title: 'Get event logs',
  description:
    'Query event logs over a block range. Filter by contract address and either an event signature (with optional ' +
    'indexed-argument values) or raw topics. The range is capped at MAX_LOG_BLOCK_RANGE blocks (default 10,000, ' +
    'about 17-33 minutes on Elysium); split longer ranges into several calls.',
  inputSchema: {
    fromBlock: z
      .union([z.number().int().nonnegative(), z.string()])
      .describe('First block (inclusive): a number or tag (latest, safe, finalized, earliest).'),
    toBlock: z
      .union([z.number().int().nonnegative(), z.string()])
      .optional()
      .describe('Last block (inclusive): a number or tag. Defaults to latest.'),
    address: z
      .union([z.string(), z.array(z.string()).max(MAX_ADDRESSES)])
      .optional()
      .describe(`Contract address, or a list of up to ${MAX_ADDRESSES}, that emitted the logs.`),
    event: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Event to filter by, as a human-readable signature ("event Transfer(address indexed from, address indexed to, uint256 value)") or a JSON ABI event item. Matching logs are decoded.',
      ),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Values for indexed event parameters, by name, e.g. {"from": "0x..."}. A list of values means "any of". Requires event.',
      ),
    topics: z
      .array(z.union([z.string(), z.array(z.string()), z.null()]))
      .max(4)
      .optional()
      .describe(
        'Raw topic filter (alternative to event): position-matched 32-byte hex values, a list for "any of", or null for wildcard.',
      ),
    abi: abiInput('Optional ABI used to decode logs (in addition to event).').optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Maximum logs to return (default ${DEFAULT_LIMIT}). The response says if results were truncated.`),
  },
  outputSchema: {
    fromBlock: z.string(),
    toBlock: z.string(),
    count: z.number().describe('Number of logs returned.'),
    totalMatched: z.number().describe('Number of logs the node returned before applying limit.'),
    truncated: z.boolean(),
    logs: z.array(decodedLogSchema),
  },
  async handler(input, { client, config }) {
    if (input.event !== undefined && input.topics !== undefined) {
      throw new ToolError('INVALID_INPUT', 'Pass either event or topics, not both.');
    }
    if (input.args !== undefined && input.event === undefined) {
      throw new ToolError('INVALID_INPUT', 'args requires event.');
    }

    let address: Address | Address[] | undefined;
    if (Array.isArray(input.address)) address = input.address.map((a, i) => parseAddress(a, `address[${i}]`));
    else if (input.address !== undefined) address = parseAddress(input.address);

    let eventItem: AbiEvent | undefined;
    let topics: (Hex | Hex[] | null)[] | undefined;
    if (input.event !== undefined) {
      // Accept "Transfer(...)" as shorthand for "event Transfer(...)".
      const shorthand = typeof input.event === 'string' && /^[A-Za-z_$][\w$]*\s*\(/.test(input.event.trim());
      const parsed = parseAbiInput(shorthand ? `event ${(input.event as string).trim()}` : input.event, 'event');
      const events = parsed.filter((i): i is AbiEvent => i.type === 'event');
      if (events.length !== 1) throw new ToolError('INVALID_ABI', 'event must describe exactly one event.');
      eventItem = events[0]!;
      const args = input.args === undefined ? undefined : indexedArgs(eventItem, input.args);
      try {
        topics = encodeEventTopics({ abi: [eventItem], eventName: eventItem.name, args: args as never }) as (
          Hex | Hex[] | null
        )[];
      } catch (err) {
        const e = toToolError(err);
        throw new ToolError('INVALID_INPUT', `Could not encode args for ${eventItem.name}: ${e.message}`, {
          hint: 'Only indexed parameters can be filtered on; check their names and types.',
        });
      }
    } else if (input.topics !== undefined) {
      topics = input.topics.map((t, i) => topicInput(t, i));
    }

    const decodeAbi = [...(eventItem ? [eventItem] : []), ...(input.abi === undefined ? [] : parseAbiInput(input.abi))];

    // Resolve the range last, so malformed inputs fail before any RPC call.
    let latestCache: Promise<bigint> | undefined;
    const latest = () => (latestCache ??= client.getBlockNumber());
    const fromBlock = await resolveBlockNumber(client, input.fromBlock, 'fromBlock', latest);
    const toBlock = await resolveBlockNumber(client, input.toBlock, 'toBlock', latest);

    if (fromBlock > toBlock) {
      throw new ToolError('INVALID_INPUT', `fromBlock (${fromBlock}) is after toBlock (${toBlock}).`);
    }
    const span = toBlock - fromBlock + 1n;
    const max = BigInt(config.maxLogBlockRange);
    if (span > max) {
      throw new ToolError('RANGE_TOO_LARGE', `The range covers ${span} blocks; the maximum is ${max}.`, {
        hint: `Split the query into ranges of at most ${max} blocks, e.g. ${fromBlock}-${fromBlock + max - 1n}.`,
        details: {
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
          requested: span.toString(),
          max: max.toString(),
        },
      });
    }

    let rpcLogs: RpcLog[];
    try {
      rpcLogs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            fromBlock: numberToHex(fromBlock),
            toBlock: numberToHex(toBlock),
            ...(address === undefined ? {} : { address }),
            ...(topics === undefined ? {} : { topics }),
          },
        ],
      });
    } catch (err) {
      const e = toToolError(err);
      if (
        !e.retryable &&
        (e.code === 'RPC_ERROR' || e.code === 'INVALID_INPUT') &&
        RANGE_ERROR_PATTERN.test(rpcMessage(err))
      ) {
        throw new ToolError('RANGE_TOO_LARGE', `The RPC node rejected the range: ${rpcMessage(err)}`, {
          hint: 'Use a smaller block range or a narrower filter (address, event, args).',
          details: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), rpcMessage: rpcMessage(err) },
          cause: err,
        });
      }
      throw e;
    }

    const limit = input.limit ?? DEFAULT_LIMIT;
    const kept = rpcLogs.slice(0, limit);
    return {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      count: kept.length,
      totalMatched: rpcLogs.length,
      truncated: rpcLogs.length > kept.length,
      logs: kept.map((l) => shapeLog(formatLog(l), decodeAbi.length ? decodeAbi : undefined)),
    };
  },
});
