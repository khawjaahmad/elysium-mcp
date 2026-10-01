import { numberToHex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { HttpFailure, rpcBlock } from './helpers/rpc.js';

describe('get_chain_status', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  const blocks: Record<string, Record<string, unknown>> = {
    latest: rpcBlock(2000, 1_000_163),
    [numberToHex(1000n)]: rpcBlock(1000, 1_000_000),
  };

  it('reports latest block, base fee, gas price and measured block time', async () => {
    const h = await createHarness({
      eth_getBlockByNumber: ([tag]) => blocks[tag as string],
      eth_gasPrice: () => '0x989680',
    });
    close = h.close;

    const data = expectOk(await h.call('get_chain_status', { sampleSize: 1000 }));
    expect(data).toMatchObject({
      chainId: 99801,
      latestBlock: { number: '2000', timestamp: '1000163' },
      baseFeePerGas: { wei: '10000000', gwei: '0.01' },
      gasPrice: { wei: '10000000', gwei: '0.01' },
      blockTime: { averageMs: 163, sampleBlocks: 1000, windowSeconds: 163, fromBlock: '1000', toBlock: '2000' },
    });
  });

  it('returns null block time when every sampled block shares one second', async () => {
    const h = await createHarness({
      eth_getBlockByNumber: ([tag]) => (tag === 'latest' ? rpcBlock(10, 500) : rpcBlock(5, 500)),
      eth_gasPrice: () => '0x1',
    });
    close = h.close;
    const data = expectOk(await h.call('get_chain_status', { sampleSize: 5 }));
    expect(data.blockTime).toMatchObject({ averageMs: null, sampleBlocks: 5, windowSeconds: 0 });
  });

  it('fails with CHAIN_MISMATCH when the RPC serves another chain', async () => {
    const h = await createHarness({ eth_chainId: () => '0x1' });
    close = h.close;
    const error = expectError(await h.call('get_chain_status'));
    expect(error).toMatchObject({ code: 'CHAIN_MISMATCH', retryable: false, details: { expected: 99801, actual: 1 } });
  });

  it('maps a persistent 503 to retryable RPC_UNAVAILABLE after retrying', async () => {
    const h = await createHarness({ eth_chainId: () => new HttpFailure(503) }, { rpcRetryCount: 2 });
    close = h.close;
    const error = expectError(await h.call('get_chain_status'));
    expect(error).toMatchObject({ code: 'RPC_UNAVAILABLE', retryable: true });
    expect(h.rpc.count('eth_chainId')).toBe(3);
  });
});
