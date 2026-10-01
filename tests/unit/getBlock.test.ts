import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { hashOf, rpcBlock, rpcTransaction } from './helpers/rpc.js';

describe('get_block', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('fetches by number and passes Arbitrum fields through', async () => {
    const h = await createHarness({
      eth_getBlockByNumber: () => rpcBlock(100, 1_700_000_000, { transactions: [hashOf(1)] }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_block', { block: 100 }));
    expect(h.rpc.calls.at(-1)).toEqual({ method: 'eth_getBlockByNumber', params: ['0x64', false] });
    expect(data.block).toMatchObject({ number: '100', baseFeePerGas: '10000000', l1BlockNumber: '0x100' });
    expect(data).toMatchObject({ timestampIso: '2023-11-14T22:13:20.000Z', transactionCount: 1 });
  });

  it('fetches by hash', async () => {
    const h = await createHarness({ eth_getBlockByHash: () => rpcBlock(7, 1) });
    close = h.close;
    expectOk(await h.call('get_block', { block: hashOf(7) }));
    expect(h.rpc.calls.at(-1)).toEqual({ method: 'eth_getBlockByHash', params: [hashOf(7), false] });
  });

  it('returns full transactions when asked', async () => {
    const h = await createHarness({
      eth_getBlockByNumber: () => rpcBlock(100, 1, { transactions: [rpcTransaction()] }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_block', { block: 'latest', includeTransactions: true }));
    expect(h.rpc.calls.at(-1)?.params).toEqual(['latest', true]);
    const txs = (data.block as { transactions: { value: string; nonce: number }[] }).transactions;
    expect(txs[0]).toMatchObject({ value: '0', nonce: 7 });
  });

  it('returns NOT_FOUND for a missing block', async () => {
    const h = await createHarness({ eth_getBlockByNumber: () => null });
    close = h.close;
    expect(expectError(await h.call('get_block', { block: 99_999_999 })).code).toBe('NOT_FOUND');
  });

  it('rejects malformed block references', async () => {
    const h = await createHarness({});
    close = h.close;
    const error = expectError(await h.call('get_block', { block: 'yesterday' }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.hint).toMatch(/latest/);
  });
});
