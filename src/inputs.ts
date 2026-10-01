import {
  BaseError,
  getAddress,
  isAddress,
  parseAbi,
  type Abi,
  type AbiParameter,
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
} from 'viem';
import { ToolError } from './errors.js';

const HEX = /^0x[0-9a-fA-F]*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_TAGS: readonly BlockTag[] = ['latest', 'pending', 'safe', 'finalized', 'earliest'];

/** Validates an address and returns its EIP-55 checksummed form. */
export function parseAddress(value: string, field = 'address'): Address {
  const v = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ToolError('INVALID_ADDRESS', `${field} "${value}" is not a 20-byte hex address.`, {
      hint: 'An address is 0x followed by exactly 40 hex characters.',
      details: { field },
    });
  }
  if (!isAddress(v)) {
    throw new ToolError('INVALID_ADDRESS', `${field} "${value}" has an invalid EIP-55 checksum.`, {
      hint: 'Mixed-case addresses must match their checksum. Re-copy the address, or pass it in all lowercase.',
      details: { field },
    });
  }
  return getAddress(v);
}

export function parseHash(value: string, field = 'hash'): Hash {
  const v = value.trim();
  if (!HASH.test(v)) {
    throw new ToolError('INVALID_INPUT', `${field} "${value}" is not a 32-byte hex hash.`, {
      hint: 'A hash is 0x followed by exactly 64 hex characters.',
      details: { field },
    });
  }
  return v.toLowerCase() as Hash;
}

export function parseHex(value: string, field: string): Hex {
  const v = value.trim();
  if (!HEX.test(v) || v.length % 2 !== 0) {
    throw new ToolError('INVALID_INPUT', `${field} must be 0x-prefixed hex with an even number of digits.`, {
      details: { field },
    });
  }
  return v.toLowerCase() as Hex;
}

/** Parses a non-negative integer given as a JS number, decimal string or 0x-hex string. */
export function parseBigInt(value: number | string, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ToolError(
        'INVALID_INPUT',
        `${field} must be an integer within JS safe range; pass large values as strings.`,
        {
          details: { field, value },
        },
      );
    }
    return BigInt(value);
  }
  const v = value.trim();
  if (/^-?\d+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  throw new ToolError('INVALID_INPUT', `${field} "${value}" is not an integer (decimal or 0x-hex).`, {
    details: { field },
  });
}

export function parseUint(value: number | string, field: string): bigint {
  const n = parseBigInt(value, field);
  if (n < 0n) throw new ToolError('INVALID_INPUT', `${field} must not be negative.`, { details: { field } });
  return n;
}

export type BlockRef = { blockNumber: bigint } | { blockTag: BlockTag } | { blockHash: Hash };

/**
 * Parses a block reference: an integer, a decimal/hex number string, a tag
 * (latest, safe, finalized, earliest, pending) or, if allowed, a block hash.
 */
export function parseBlockRef(
  value: number | string | undefined,
  opts: { allowHash?: boolean; field?: string } = {},
): BlockRef {
  const field = opts.field ?? 'block';
  if (value === undefined) return { blockTag: 'latest' };
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((BLOCK_TAGS as readonly string[]).includes(v)) return { blockTag: v as BlockTag };
    if (HASH.test(v)) {
      if (opts.allowHash) return { blockHash: v as Hash };
      throw new ToolError('INVALID_INPUT', `${field} does not accept a block hash here; use a block number or tag.`, {
        details: { field },
      });
    }
  }
  try {
    return { blockNumber: parseUint(value, field) };
  } catch {
    throw new ToolError(
      'INVALID_INPUT',
      `${field} "${String(value)}" is not a block number, tag${opts.allowHash ? ' or block hash' : ''}.`,
      {
        hint: `Use an integer block number or one of: ${BLOCK_TAGS.join(', ')}${opts.allowHash ? ', or a 32-byte block hash' : ''}.`,
        details: { field },
      },
    );
  }
}

/** Block reference in the shape viem's read actions accept (no hash). */
export function blockParams(ref: BlockRef): { blockNumber: bigint } | { blockTag: BlockTag } {
  if ('blockHash' in ref) throw new ToolError('INVALID_INPUT', 'A block hash is not accepted here.');
  return ref;
}

const ABI_ITEM_TYPES = new Set(['function', 'event', 'error', 'constructor', 'fallback', 'receive']);

/**
 * Accepts an ABI as: a JSON ABI array, a single JSON ABI item, a JSON string
 * of either, an array of human-readable signatures
 * (e.g. "function balanceOf(address owner) view returns (uint256)"), or a
 * single human-readable signature.
 */
export function parseAbiInput(input: unknown, field = 'abi'): Abi {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        throw new ToolError('INVALID_ABI', `${field} looks like JSON but could not be parsed.`, { details: { field } });
      }
    } else {
      value = [trimmed];
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError('INVALID_ABI', `${field} must be a non-empty ABI array or human-readable signature list.`, {
      details: { field },
    });
  }

  if (value.every((v) => typeof v === 'string')) {
    try {
      return parseAbi(value as string[]);
    } catch (err) {
      throw new ToolError('INVALID_ABI', `${field}: ${err instanceof BaseError ? err.shortMessage : String(err)}`, {
        hint: 'Human-readable items look like "function balanceOf(address owner) view returns (uint256)" or "event Transfer(address indexed from, address indexed to, uint256 value)".',
        details: { field },
      });
    }
  }

  value.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || typeof (item as { type?: unknown }).type !== 'string') {
      throw new ToolError('INVALID_ABI', `${field}[${i}] is not an ABI item object with a "type".`, {
        hint: 'Do not mix human-readable strings and JSON objects in one ABI.',
        details: { field, index: i },
      });
    }
    const { type, name, inputs } = item as { type: string; name?: unknown; inputs?: unknown };
    if (!ABI_ITEM_TYPES.has(type)) {
      throw new ToolError('INVALID_ABI', `${field}[${i}] has unknown type "${type}".`, {
        details: { field, index: i },
      });
    }
    if (
      (type === 'function' || type === 'event' || type === 'error') &&
      (typeof name !== 'string' || !Array.isArray(inputs))
    ) {
      throw new ToolError('INVALID_ABI', `${field}[${i}] (${type}) needs a "name" string and an "inputs" array.`, {
        details: { field, index: i },
      });
    }
  });
  return value as Abi;
}

/**
 * Converts JSON arguments into the values viem's ABI encoder expects:
 * integers (number, decimal string or hex string) become bigint, addresses
 * are validated, tuples may be given as arrays or objects.
 */
export function coerceArgs(params: readonly AbiParameter[], args: readonly unknown[], field = 'args'): unknown[] {
  if (args.length !== params.length) {
    throw new ToolError(
      'INVALID_INPUT',
      `${field} has ${args.length} value(s) but the function expects ${params.length}.`,
      {
        details: { field, expected: params.map((p) => `${p.type}${p.name ? ` ${p.name}` : ''}`) },
      },
    );
  }
  return params.map((p, i) => coerceArg(p, args[i], `${field}[${i}]${p.name ? ` (${p.name})` : ''}`));
}

/** Coerces a single JSON value to the type viem expects for `param`. */
export function coerceArg(param: AbiParameter, value: unknown, path: string): unknown {
  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (arrayMatch) {
    const [, innerType, len] = arrayMatch;
    if (!Array.isArray(value)) throw invalid(path, `an array of ${innerType}`);
    if (len !== '' && value.length !== Number(len)) throw invalid(path, `an array of exactly ${len} items`);
    const inner = { ...param, type: innerType! } as AbiParameter;
    return value.map((v, i) => coerceArg(inner, v, `${path}[${i}]`));
  }

  if (param.type === 'tuple') {
    const components = 'components' in param ? param.components : [];
    if (Array.isArray(value)) return coerceArgs(components, value, path);
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const c of components) {
        if (!c.name) throw invalid(path, 'an array (the tuple has unnamed components)');
        if (!(c.name in obj)) throw invalid(path, `an object with key "${c.name}"`);
        out[c.name] = coerceArg(c, obj[c.name], `${path}.${c.name}`);
      }
      return out;
    }
    throw invalid(path, 'a tuple (array or object)');
  }

  if (/^u?int\d*$/.test(param.type)) {
    if (typeof value !== 'number' && typeof value !== 'string') throw invalid(path, `an integer (${param.type})`);
    const n = parseBigInt(value, path);
    if (param.type.startsWith('u') && n < 0n) throw invalid(path, `a non-negative integer (${param.type})`);
    return n;
  }

  switch (param.type) {
    case 'address':
      if (typeof value !== 'string') throw invalid(path, 'an address string');
      return parseAddress(value, path);
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw invalid(path, 'a boolean');
    case 'string':
      if (typeof value !== 'string') throw invalid(path, 'a string');
      return value;
    default:
      if (/^bytes\d*$/.test(param.type)) {
        if (typeof value !== 'string') throw invalid(path, `0x-hex (${param.type})`);
        return parseHex(value, path);
      }
      return value;
  }
}

function invalid(path: string, expected: string): ToolError {
  return new ToolError('INVALID_INPUT', `${path} must be ${expected}.`, { details: { field: path } });
}
