import { pad, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { ERC20, transferLog } from './fixtures.js';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { ALICE, BOB, rpcBlock, RpcFailure, TOKEN } from './helpers/rpc.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

describe('get_logs', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('filters by event and indexed args, and decodes matching logs', async () => {
    const h = await createHarness({
      eth_getLogs: () => [transferLog(ALICE as Hex, BOB as Hex, 7n)],
    });
    close = h.close;
    const data = expectOk(
      await h.call('get_logs', {
        fromBlock: 100,
        toBlock: 200,
        address: TOKEN,
        event: 'Transfer(address indexed from, address indexed to, uint256 value)',
        args: { from: ALICE },
      }),
    );
    expect(h.rpc.calls.at(-1)).toEqual({
      method: 'eth_getLogs',
      params: [
        {
          fromBlock: '0x64',
          toBlock: '0xc8',
          address: TOKEN,
          // The trailing null is viem's wildcard for the unfiltered `to` topic.
          topics: [TRANSFER_TOPIC, pad(ALICE.toLowerCase() as Hex), null],
        },
      ],
    });
    expect(data).toMatchObject({ fromBlock: '100', toBlock: '200', count: 1, totalMatched: 1, truncated: false });
    expect((data.logs as { decoded: unknown }[])[0]?.decoded).toEqual({
      eventName: 'Transfer',
      args: { from: ALICE, to: BOB, value: '7' },
    });
  });

  it('resolves "latest" and defaults toBlock to it', async () => {
    const h = await createHarness({ eth_blockNumber: () => '0x3e8', eth_getLogs: () => [] });
    close = h.close;
    const data = expectOk(await h.call('get_logs', { fromBlock: 990 }));
    expect(data).toMatchObject({ fromBlock: '990', toBlock: '1000', count: 0 });
    expect(h.rpc.count('eth_blockNumber')).toBe(1);
  });

  it('resolves safe/finalized tags through the node', async () => {
    const h = await createHarness({
      eth_blockNumber: () => '0x3e8',
      eth_getBlockByNumber: () => rpcBlock(900, 1),
      eth_getLogs: () => [],
    });
    close = h.close;
    const data = expectOk(await h.call('get_logs', { fromBlock: 'finalized', toBlock: 'latest' }));
    expect(data).toMatchObject({ fromBlock: '900', toBlock: '1000' });
  });

  it('rejects ranges over the cap before calling the node', async () => {
    const h = await createHarness({ eth_getLogs: () => [] }, { maxLogBlockRange: 100 });
    close = h.close;
    const error = expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 101 }));
    expect(error).toMatchObject({
      code: 'RANGE_TOO_LARGE',
      retryable: false,
      details: { requested: '101', max: '100' },
    });
    expect(error.hint).toMatch(/1-100/);
    expect(h.rpc.count('eth_getLogs')).toBe(0);
    // Exactly at the cap is fine.
    expectOk(await h.call('get_logs', { fromBlock: 1, toBlock: 100 }));
  });

  it('caps unfiltered queries at 2,000 blocks by default, counting all-null topics as unfiltered', async () => {
    const h = await createHarness({ eth_getLogs: () => [] });
    close = h.close;
    for (const filter of [{}, { topics: [null, null] }, { address: [] }]) {
      const error = expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 2001, ...filter }));
      expect(error).toMatchObject({ code: 'RANGE_TOO_LARGE', details: { requested: '2001', max: '2000' } });
      expect(error.hint).toMatch(/filter by address, event or topics/);
    }
    expect(h.rpc.count('eth_getLogs')).toBe(0);
  });

  it('sends filtered queries of any range to the node', async () => {
    const h = await createHarness({ eth_getLogs: () => [] });
    close = h.close;
    for (const filter of [
      { address: TOKEN },
      { topics: [TRANSFER_TOPIC] },
      { topics: [null, pad(ALICE.toLowerCase() as Hex)] },
      { event: 'Transfer(address indexed from, address indexed to, uint256 value)' },
    ]) {
      expectOk(await h.call('get_logs', { fromBlock: 1, toBlock: 100_000, ...filter }));
    }
    expect(h.rpc.count('eth_getLogs')).toBe(4);
  });

  // Exact messages returned by the Elysium testnet RPC (live run, 2026-10-02).
  it('maps the RPC block-range rejection to RANGE_TOO_LARGE with the node limit', async () => {
    const h = await createHarness({
      eth_getLogs: () => {
        throw new RpcFailure(
          -32602,
          'eth_getLogs block range 9999 exceeds maximum of 2000; narrow fromBlock–toBlock or filter by address/topics',
        );
      },
    });
    close = h.close;
    const error = expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 50 }));
    expect(error.code).toBe('RANGE_TOO_LARGE');
    expect(error.message).toMatch(/exceeds maximum of 2000/);
    expect(error.details).toMatchObject({ reason: 'block_range', nodeLimit: 2000, rpcCode: -32602 });
    expect(error.hint).toMatch(/at most 2000 blocks/);
  });

  it('maps the RPC log-count rejection to RANGE_TOO_LARGE without retrying', async () => {
    const h = await createHarness({
      eth_getLogs: () => {
        throw new RpcFailure(-32005, 'logs count limit exceeded (10000) consider refine/narrow down your query');
      },
    });
    close = h.close;
    const error = expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 50 }));
    expect(error).toMatchObject({
      code: 'RANGE_TOO_LARGE',
      retryable: false,
      details: { reason: 'too_many_logs', nodeLimit: 10000, rpcCode: -32005 },
    });
    expect(h.rpc.count('eth_getLogs')).toBe(1);
  });

  it('does not guess: other limit-sounding wording stays RPC_ERROR', async () => {
    const h = await createHarness({
      eth_getLogs: () => {
        throw new RpcFailure(-32000, 'query returned more than 10000 results');
      },
    });
    close = h.close;
    expect(expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 50 })).code).toBe('RPC_ERROR');
  });

  it('keeps unrelated node errors as RPC_ERROR', async () => {
    const h = await createHarness({
      eth_getLogs: () => {
        throw new RpcFailure(-32000, 'header not found');
      },
    });
    close = h.close;
    expect(expectError(await h.call('get_logs', { fromBlock: 1, toBlock: 2 })).code).toBe('RPC_ERROR');
  });

  it('truncates to limit and says so', async () => {
    const logs = [1n, 2n, 3n].map((v, i) =>
      transferLog(ALICE as Hex, BOB as Hex, v, { logIndex: `0x${i.toString(16)}` }),
    );
    const h = await createHarness({ eth_getLogs: () => logs });
    close = h.close;
    const data = expectOk(await h.call('get_logs', { fromBlock: 1, toBlock: 2, limit: 2, abi: ERC20 }));
    expect(data).toMatchObject({ count: 2, totalMatched: 3, truncated: true });
  });

  it('accepts raw topics with wildcards', async () => {
    const h = await createHarness({ eth_getLogs: () => [] });
    close = h.close;
    expectOk(await h.call('get_logs', { fromBlock: 1, toBlock: 2, topics: [TRANSFER_TOPIC, null, [pad(BOB as Hex)]] }));
    expect((h.rpc.calls.at(-1)?.params[0] as { topics: unknown }).topics).toEqual([
      TRANSFER_TOPIC,
      null,
      [pad(BOB.toLowerCase() as Hex)],
    ]);
  });

  it('validates inputs', async () => {
    const h = await createHarness({});
    close = h.close;
    expect(expectError(await h.call('get_logs', { fromBlock: 10, toBlock: 5 })).code).toBe('INVALID_INPUT');
    expect(
      expectError(await h.call('get_logs', { fromBlock: 1, event: 'Transfer(address)', topics: [TRANSFER_TOPIC] }))
        .code,
    ).toBe('INVALID_INPUT');
    expect(expectError(await h.call('get_logs', { fromBlock: 1, args: { from: ALICE } })).code).toBe('INVALID_INPUT');
    expect(expectError(await h.call('get_logs', { fromBlock: 1, address: 'nope' })).code).toBe('INVALID_ADDRESS');
    expect(expectError(await h.call('get_logs', { fromBlock: 1, topics: [ALICE] })).code).toBe('INVALID_INPUT');
    expect(
      expectError(
        await h.call('get_logs', {
          fromBlock: 1,
          event: 'Transfer(address indexed from, address indexed to, uint256 value)',
          args: { value: 1 },
        }),
      ).code,
    ).toBe('INVALID_INPUT');
  });
});
