import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { callData, ERC20, erc20Handler, revertWith } from './fixtures.js';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { ALICE, TOKEN } from './helpers/rpc.js';

const POOL = parseAbi([
  'struct Slot { uint160 price; int24 tick; bool unlocked; }',
  'function slot0() view returns (Slot)',
  'function quote(uint256 amountIn, address[] path) view returns (uint256 amountOut)',
  'function owner() view returns (address)',
]);

describe('read_contract', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('calls a view function with string integer arguments and returns decimal strings', async () => {
    const h = await createHarness({ eth_call: erc20Handler({ balance: 123n * 10n ** 18n }) });
    close = h.close;
    const data = expectOk(
      await h.call('read_contract', {
        address: TOKEN,
        abi: ['function balanceOf(address owner) view returns (uint256)'],
        functionName: 'balanceOf',
        args: [ALICE.toLowerCase()],
        block: 'finalized',
      }),
    );
    expect(data).toEqual({
      address: TOKEN,
      functionName: 'balanceOf',
      signature: 'balanceOf(address)',
      result: '123000000000000000000',
    });
    expect(h.rpc.calls.at(-1)?.params[1]).toBe('finalized');
  });

  it('encodes uint and array arguments from strings and decodes struct results', async () => {
    let seenArgs: readonly unknown[] | undefined;
    const h = await createHarness({
      eth_call: (params) => {
        const data = callData(params);
        const decoded = decodeFunctionData({ abi: POOL, data });
        if (decoded.functionName === 'quote') {
          seenArgs = decoded.args;
          return encodeFunctionResult({ abi: POOL, functionName: 'quote', result: 42n });
        }
        return encodeFunctionResult({
          abi: POOL,
          functionName: 'slot0',
          result: { price: 2n ** 96n, tick: -100, unlocked: true },
        });
      },
    });
    close = h.close;

    const quote = expectOk(
      await h.call('read_contract', {
        address: TOKEN,
        abi: POOL,
        functionName: 'quote',
        args: ['1000000000000000000000', [ALICE, TOKEN]],
      }),
    );
    expect(quote.result).toBe('42');
    expect(seenArgs).toEqual([10n ** 21n, [ALICE, TOKEN]]);

    const slot = expectOk(await h.call('read_contract', { address: TOKEN, abi: POOL, functionName: 'slot0' }));
    expect(slot.result).toEqual({ price: (2n ** 96n).toString(), tick: -100, unlocked: true });
  });

  it('refuses non-view functions and points to simulate_call', async () => {
    const h = await createHarness({});
    close = h.close;
    const error = expectError(
      await h.call('read_contract', { address: TOKEN, abi: ERC20, functionName: 'transfer', args: [ALICE, 1] }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.hint).toMatch(/simulate_call/);
  });

  it('reports functions missing from the ABI and wrong argument counts', async () => {
    const h = await createHarness({});
    close = h.close;
    const missing = expectError(await h.call('read_contract', { address: TOKEN, abi: ERC20, functionName: 'balance' }));
    expect(missing.code).toBe('ABI_MISMATCH');
    expect(missing.hint).toMatch(/balanceOf/);

    const arity = expectError(
      await h.call('read_contract', { address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [] }),
    );
    expect(arity.code).toBe('INVALID_INPUT');

    const badArg = expectError(
      await h.call('read_contract', { address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: ['nope'] }),
    );
    expect(badArg.code).toBe('INVALID_ADDRESS');
  });

  it('returns EXECUTION_REVERTED with the revert reason', async () => {
    const h = await createHarness({
      eth_call: () => {
        throw revertWith('Ownable: caller is not the owner');
      },
    });
    close = h.close;
    const error = expectError(await h.call('read_contract', { address: TOKEN, abi: POOL, functionName: 'owner' }));
    expect(error.code).toBe('EXECUTION_REVERTED');
    expect(error.details).toMatchObject({ reason: 'Ownable: caller is not the owner' });
  });

  it('distinguishes a non-contract address from an ABI mismatch when the call returns no data', async () => {
    const eoa = await createHarness({ eth_call: () => '0x', eth_getCode: () => '0x' });
    close = eoa.close;
    expect(
      expectError(await eoa.call('read_contract', { address: TOKEN, abi: POOL, functionName: 'owner' })).code,
    ).toBe('NOT_A_CONTRACT');
    await eoa.close();

    const contract = await createHarness({ eth_call: () => '0x', eth_getCode: () => '0x6080' });
    close = contract.close;
    expect(
      expectError(await contract.call('read_contract', { address: TOKEN, abi: POOL, functionName: 'owner' })).code,
    ).toBe('ABI_MISMATCH');
  });
});
