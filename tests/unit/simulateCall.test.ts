import { encodeErrorResult, encodeFunctionResult } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { ERC20, revertWith, SELECTOR } from './fixtures.js';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { ALICE, BOB, HANG, RpcFailure, TOKEN } from './helpers/rpc.js';

describe('simulate_call', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('encodes the call, decodes the result and estimates gas and fee', async () => {
    const h = await createHarness({
      eth_gasPrice: () => '0x989680', // 0.01 gwei
      eth_call: () => encodeFunctionResult({ abi: ERC20, functionName: 'transfer', result: true }),
      eth_estimateGas: () => '0xc350', // 50,000
    });
    close = h.close;
    const data = expectOk(
      await h.call('simulate_call', {
        from: ALICE,
        to: TOKEN,
        abi: ERC20,
        functionName: 'transfer',
        args: [BOB, '1000'],
      }),
    );
    expect(data).toMatchObject({
      success: true,
      decodedResult: true,
      signature: 'transfer(address,uint256)',
      gasEstimate: '50000',
      gasPrice: { wei: '10000000', gwei: '0.01' },
      estimatedFee: { wei: '500000000000', formatted: '0.0000005', symbol: 'HYPE' },
    });
    const call = h.rpc.calls.find((c) => c.method === 'eth_call');
    expect(call?.params[0]).toMatchObject({ from: ALICE.toLowerCase(), to: TOKEN.toLowerCase() });
    expect((call?.params[0] as { data: string }).data.startsWith(SELECTOR.transfer)).toBe(true);
  });

  it('simulates a plain HYPE transfer with a wei value', async () => {
    const h = await createHarness({ eth_gasPrice: () => '0x1', eth_call: () => '0x', eth_estimateGas: () => '0x5208' });
    close = h.close;
    const data = expectOk(await h.call('simulate_call', { from: ALICE, to: BOB, value: '1000000000000000000' }));
    expect(data).toMatchObject({ success: true, returnData: '0x', gasEstimate: '21000' });
    expect(h.rpc.calls.find((c) => c.method === 'eth_call')?.params[0]).toMatchObject({ value: '0xde0b6b3a7640000' });
  });

  it('returns success: false with the decoded reason when the call would revert', async () => {
    const h = await createHarness({
      eth_gasPrice: () => '0x1',
      eth_call: () => {
        throw revertWith('ERC20: transfer amount exceeds balance');
      },
    });
    close = h.close;
    const data = expectOk(
      await h.call('simulate_call', { to: TOKEN, abi: ERC20, functionName: 'transfer', args: [BOB, 1] }),
    );
    expect(data).toMatchObject({
      success: false,
      returnData: null,
      gasEstimate: null,
      estimatedFee: null,
      revert: { reason: 'ERC20: transfer amount exceeds balance', errorName: 'Error' },
    });
    expect(h.rpc.count('eth_estimateGas')).toBe(0);
  });

  it('decodes custom errors from the supplied ABI', async () => {
    const data = encodeErrorResult({ abi: ERC20, errorName: 'InsufficientBalance', args: [5n, 10n] });
    const h = await createHarness({
      eth_gasPrice: () => '0x1',
      eth_call: () => {
        throw new RpcFailure(3, 'execution reverted', data);
      },
    });
    close = h.close;
    const result = expectOk(
      await h.call('simulate_call', { to: TOKEN, abi: ERC20, functionName: 'transfer', args: [BOB, 10] }),
    );
    expect(result.revert).toMatchObject({ errorName: 'InsufficientBalance', errorArgs: ['5', '10'], data });
  });

  it('reports non-revert node failures such as insufficient funds as success: false', async () => {
    const h = await createHarness({
      eth_gasPrice: () => '0x1',
      eth_call: () => {
        throw new RpcFailure(-32000, 'insufficient funds for gas * price + value');
      },
    });
    close = h.close;
    const data = expectOk(await h.call('simulate_call', { from: ALICE, to: BOB, value: 10 }));
    expect(data).toMatchObject({ success: false, error: expect.stringMatching(/insufficient funds/) });
  });

  it('keeps a successful call result when only gas estimation fails', async () => {
    const h = await createHarness({
      eth_gasPrice: () => '0x1',
      eth_call: () => '0x',
      eth_estimateGas: () => {
        throw new RpcFailure(-32000, 'gas required exceeds allowance');
      },
    });
    close = h.close;
    const data = expectOk(await h.call('simulate_call', { to: BOB, data: '0x' }));
    expect(data).toMatchObject({ success: true, gasEstimate: null, estimatedFee: null });
    expect(data.gasEstimateError).toMatch(/gas required exceeds allowance/);
  });

  it('returns RPC_TIMEOUT when the node does not answer', async () => {
    const h = await createHarness(
      { eth_gasPrice: () => '0x1', eth_call: () => HANG },
      { rpcTimeoutMs: 20, rpcRetryCount: 1 },
    );
    close = h.close;
    const error = expectError(await h.call('simulate_call', { to: BOB }));
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT', retryable: true });
    expect(h.rpc.count('eth_call')).toBe(2);
  });

  it('validates input combinations', async () => {
    const h = await createHarness({});
    close = h.close;
    const cases: Record<string, unknown>[] = [
      { to: TOKEN, data: '0x00', abi: ERC20, functionName: 'transfer' },
      { to: TOKEN, abi: ERC20 },
      { to: TOKEN, args: [1] },
      { to: TOKEN, data: '0xzz' },
      { to: TOKEN, value: '-1' },
    ];
    for (const args of cases) {
      expect(expectError(await h.call('simulate_call', args)).code, JSON.stringify(args)).toBe('INVALID_INPUT');
    }
  });
});
