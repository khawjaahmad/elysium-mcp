import { encodeFunctionData, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { ERC20, transferLog } from './fixtures.js';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { ALICE, BOB, rpcReceipt, rpcTransaction, TX_HASH } from './helpers/rpc.js';

describe('get_transaction', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  const input = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [BOB, 1000n] });

  it('returns transaction, receipt and fee, with logs and input decoded by the ABI', async () => {
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction({ input }),
      eth_getTransactionReceipt: () =>
        rpcReceipt({ logs: [transferLog(ALICE as Hex, BOB as Hex, 1000n)], gasUsedForL1: '0x10' }),
    });
    close = h.close;

    const data = expectOk(await h.call('get_transaction', { hash: TX_HASH, abi: ERC20 }));
    expect(data.status).toBe('success');
    expect(data.transactionType).toEqual({ code: 2, name: 'eip1559', origin: 'user' });
    expect(data.systemTransaction).toBe(false);
    expect(data).not.toHaveProperty('note');
    expect(data.fee).toEqual({ wei: '210000000000', formatted: '0.00000021', symbol: 'HYPE' });
    expect(data.value).toEqual({ wei: '0', formatted: '0', symbol: 'HYPE' });
    expect(data.receipt).toMatchObject({ gasUsed: '21000', gasUsedForL1: '0x10' });
    expect(data.receipt).not.toHaveProperty('logs');
    expect(data.decodedInput).toEqual({ functionName: 'transfer', args: [BOB, '1000'] });
    const logs = data.logs as { decoded: unknown }[];
    expect(logs[0]?.decoded).toEqual({ eventName: 'Transfer', args: { from: ALICE, to: BOB, value: '1000' } });
  });

  it('accepts human-readable ABI strings', async () => {
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction(),
      eth_getTransactionReceipt: () => rpcReceipt({ logs: [transferLog(ALICE as Hex, BOB as Hex, 5n)] }),
    });
    close = h.close;
    const data = expectOk(
      await h.call('get_transaction', {
        hash: TX_HASH,
        abi: ['event Transfer(address indexed from, address indexed to, uint256 value)'],
      }),
    );
    expect((data.logs as { decoded: { eventName: string } }[])[0]?.decoded.eventName).toBe('Transfer');
  });

  it('leaves logs undecoded without an ABI, and flags logs that match by name but not by shape', async () => {
    // Same Transfer signature but with the value indexed too (as ERC-721 does): 4 topics, no data.
    const nftStyle = transferLog(ALICE as Hex, BOB as Hex, 0n, {
      topics: [...transferLog(ALICE as Hex, BOB as Hex, 0n).topics, `0x${'0'.repeat(63)}9`],
      data: '0x',
    });
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction(),
      eth_getTransactionReceipt: () => rpcReceipt({ logs: [nftStyle] }),
    });
    close = h.close;

    const plain = expectOk(await h.call('get_transaction', { hash: TX_HASH }));
    expect((plain.logs as { decoded: unknown }[])[0]?.decoded).toBeNull();

    const withAbi = expectOk(await h.call('get_transaction', { hash: TX_HASH, abi: ERC20 }));
    const log = (withAbi.logs as { decoded: unknown; decodeError?: string }[])[0];
    expect(log?.decoded).toBeNull();
    expect(log?.decodeError).toBeTruthy();
  });

  it('flags ArbOS internal transactions (type 0x6a) as system transactions with a zero fee', async () => {
    // Shape of the startBlock transaction at index 0 of every Elysium block (observed on testnet).
    const arbos = '0x00000000000000000000000000000000000a4b05';
    const h = await createHarness({
      eth_getTransactionByHash: () =>
        rpcTransaction({
          type: '0x6a',
          from: arbos,
          to: arbos,
          input: '0x6bf6a42d',
          gas: '0x0',
          transactionIndex: '0x0',
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined,
        }),
      eth_getTransactionReceipt: () => rpcReceipt({ type: '0x6a', from: arbos, to: arbos, gasUsed: '0x0' }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_transaction', { hash: TX_HASH }));
    expect(data.transactionType).toEqual({ code: 106, name: 'ArbitrumInternalTx', origin: 'arbos' });
    expect(data.systemTransaction).toBe(true);
    expect(data.note).toMatch(/not sent by any user/);
    expect(data.fee).toEqual({ wei: '0', formatted: '0', symbol: 'HYPE' });
  });

  it('labels Arbitrum bridge transactions and unknown type codes', async () => {
    let type = '0x64';
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction({ type }),
      eth_getTransactionReceipt: () => rpcReceipt({ type }),
    });
    close = h.close;
    const deposit = expectOk(await h.call('get_transaction', { hash: TX_HASH }));
    expect(deposit.transactionType).toEqual({ code: 100, name: 'ArbitrumDepositTx', origin: 'bridge' });
    expect(deposit.systemTransaction).toBe(false);
    type = '0x7f';
    const unknown = expectOk(await h.call('get_transaction', { hash: TX_HASH }));
    expect(unknown.transactionType).toEqual({ code: 127, name: 'unknown', origin: 'unknown' });
  });

  it('returns a null fee when the node reports no effectiveGasPrice', async () => {
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction(),
      eth_getTransactionReceipt: () => rpcReceipt({ effectiveGasPrice: undefined }),
    });
    close = h.close;
    expect(expectOk(await h.call('get_transaction', { hash: TX_HASH })).fee).toBeNull();
  });

  it('reports pending transactions with a null receipt', async () => {
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction({ blockHash: null, blockNumber: null, transactionIndex: null }),
      eth_getTransactionReceipt: () => null,
    });
    close = h.close;
    const data = expectOk(await h.call('get_transaction', { hash: TX_HASH }));
    expect(data).toMatchObject({ status: 'pending', receipt: null, fee: null });
  });

  it('reports reverted transactions', async () => {
    const h = await createHarness({
      eth_getTransactionByHash: () => rpcTransaction(),
      eth_getTransactionReceipt: () => rpcReceipt({ status: '0x0' }),
    });
    close = h.close;
    expect(expectOk(await h.call('get_transaction', { hash: TX_HASH })).status).toBe('reverted');
  });

  it('returns NOT_FOUND for an unknown hash and INVALID_INPUT for a malformed one', async () => {
    const h = await createHarness({ eth_getTransactionByHash: () => null, eth_getTransactionReceipt: () => null });
    close = h.close;
    expect(expectError(await h.call('get_transaction', { hash: TX_HASH })).code).toBe('NOT_FOUND');
    expect(expectError(await h.call('get_transaction', { hash: '0x1234' })).code).toBe('INVALID_INPUT');
  });

  it('rejects an invalid ABI with INVALID_ABI', async () => {
    const h = await createHarness({});
    close = h.close;
    const error = expectError(await h.call('get_transaction', { hash: TX_HASH, abi: ['not a signature'] }));
    expect(error.code).toBe('INVALID_ABI');
  });
});
