import { parseAbi, type AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { coerceArgs, parseAbiInput, parseAddress, parseBlockRef, parseUint } from '../../src/inputs.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ToolError ? err.code : 'NOT_A_TOOL_ERROR';
  }
  return undefined;
}

describe('parseAddress', () => {
  it('returns the checksummed form of valid addresses', () => {
    expect(parseAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    );
    expect(parseAddress(' 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ')).toBe(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    );
  });

  it('rejects wrong length, non-hex and bad checksums', () => {
    expect(codeOf(() => parseAddress('0x1234'))).toBe('INVALID_ADDRESS');
    expect(codeOf(() => parseAddress('d8da6bf26964af9d7eed9e03e53415d37aa96045'))).toBe('INVALID_ADDRESS');
    expect(codeOf(() => parseAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046'.replace('dA', 'Da')))).toBe(
      'INVALID_ADDRESS',
    );
  });
});

describe('parseBlockRef', () => {
  it('parses numbers, numeric strings, tags and hashes', () => {
    expect(parseBlockRef(undefined)).toEqual({ blockTag: 'latest' });
    expect(parseBlockRef(42)).toEqual({ blockNumber: 42n });
    expect(parseBlockRef('42')).toEqual({ blockNumber: 42n });
    expect(parseBlockRef('0x2a')).toEqual({ blockNumber: 42n });
    expect(parseBlockRef('Finalized')).toEqual({ blockTag: 'finalized' });
    const hash = `0x${'a'.repeat(64)}`;
    expect(parseBlockRef(hash, { allowHash: true })).toEqual({ blockHash: hash });
  });

  it('rejects hashes where not allowed, negatives and garbage', () => {
    expect(codeOf(() => parseBlockRef(`0x${'a'.repeat(64)}`))).toBe('INVALID_INPUT');
    expect(codeOf(() => parseBlockRef('-1'))).toBe('INVALID_INPUT');
    expect(codeOf(() => parseBlockRef('tomorrow'))).toBe('INVALID_INPUT');
    expect(codeOf(() => parseBlockRef(1.5))).toBe('INVALID_INPUT');
  });
});

describe('parseUint', () => {
  it('accepts large values as strings but not unsafe JS numbers', () => {
    expect(parseUint('1000000000000000000000', 'v')).toBe(10n ** 21n);
    expect(codeOf(() => parseUint(2 ** 60, 'v'))).toBe('INVALID_INPUT');
  });
});

describe('parseAbiInput', () => {
  const transfer = 'function transfer(address to, uint256 amount) returns (bool)';

  it('accepts human-readable lists, single signatures, JSON arrays, single items and JSON strings', () => {
    const fromHuman = parseAbiInput([transfer]);
    expect(fromHuman[0]).toMatchObject({ type: 'function', name: 'transfer' });
    expect(parseAbiInput(transfer)).toEqual(fromHuman);
    expect(parseAbiInput(fromHuman)).toEqual(fromHuman);
    expect(parseAbiInput(fromHuman[0])).toEqual(fromHuman);
    expect(parseAbiInput(JSON.stringify(fromHuman))).toEqual(fromHuman);
  });

  it('rejects empty, malformed, mixed and incomplete ABIs with INVALID_ABI', () => {
    expect(codeOf(() => parseAbiInput([]))).toBe('INVALID_ABI');
    expect(codeOf(() => parseAbiInput('[not json'))).toBe('INVALID_ABI');
    expect(codeOf(() => parseAbiInput(['function (']))).toBe('INVALID_ABI');
    expect(codeOf(() => parseAbiInput([transfer, { type: 'function' }]))).toBe('INVALID_ABI');
    expect(codeOf(() => parseAbiInput([{ type: 'function', name: 'x' }]))).toBe('INVALID_ABI');
    expect(codeOf(() => parseAbiInput([{ type: 'banana', name: 'x', inputs: [] }]))).toBe('INVALID_ABI');
  });
});

describe('coerceArgs', () => {
  const [fn] = parseAbi([
    'struct Order { address maker; uint128 amount; bool buy; }',
    'function place(Order order, int24[2] ticks, bytes data, string note, uint256[] ids) returns (bool)',
  ]);
  const params = (fn as { inputs: readonly AbiParameter[] }).inputs;
  const maker = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

  it('converts integers to bigint, validates addresses and accepts tuples as objects or arrays', () => {
    const out = coerceArgs(params, [{ maker, amount: '5', buy: 'true' }, [-1, '0x10'], '0xABCD', 'hi', [1, '2']]);
    expect(out).toEqual([
      { maker: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', amount: 5n, buy: true },
      [-1n, 16n],
      '0xabcd',
      'hi',
      [1n, 2n],
    ]);
    expect(coerceArgs(params, [[maker, 5, false], [0, 0], '0x', '', []])[0]).toEqual([
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      5n,
      false,
    ]);
  });

  it('reports precise paths for bad values', () => {
    const run = (args: unknown[]) => {
      try {
        coerceArgs(params, args);
      } catch (err) {
        return (err as ToolError).message;
      }
      return 'no error';
    };
    const good = [{ maker, amount: 1, buy: true }, [0, 0], '0x', '', []];
    expect(run(good.slice(0, 4))).toMatch(/4 value\(s\) but the function expects 5/);
    expect(run([{ maker, amount: 1 }, ...good.slice(1)])).toMatch(
      /args\[0\] \(order\) must be an object with key "buy"/,
    );
    expect(run([good[0], [0], ...good.slice(2)])).toMatch(/exactly 2 items/);
    expect(run([...good.slice(0, 4), [1.5]])).toMatch(/args\[4\] \(ids\)\[0\]/);
    expect(run([...good.slice(0, 4), ['-1']])).toMatch(/non-negative/);
  });
});
