import { afterEach, describe, expect, it } from 'vitest';
import { erc20Handler } from './fixtures.js';
import { createHarness, expectError, expectOk } from './helpers/harness.js';
import { ALICE, HANG, TOKEN } from './helpers/rpc.js';

const OTHER_TOKEN = '0x4444444444444444444444444444444444444444';

describe('get_balance', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('returns the native HYPE balance using 18 decimals', async () => {
    const h = await createHarness({ eth_getBalance: () => '0x14d1120d7b160000' }); // 1.5e18
    close = h.close;
    const data = expectOk(await h.call('get_balance', { address: ALICE }));
    expect(data).toEqual({
      address: ALICE,
      native: { wei: '1500000000000000000', formatted: '1.5', symbol: 'HYPE' },
      tokens: [],
    });
    expect(h.rpc.calls.at(-1)).toEqual({ method: 'eth_getBalance', params: [ALICE, 'latest'] });
  });

  it('returns ERC-20 balances and reports per-token failures without failing the call', async () => {
    const h = await createHarness({
      eth_getBalance: () => '0x0',
      eth_getCode: ([address]) => ((address as string).toLowerCase() === TOKEN ? '0x6080' : '0x'),
      eth_call: erc20Handler({ symbol: 'TKN', decimals: 6, balance: 2_500_000n }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_balance', { address: ALICE, tokens: [TOKEN, OTHER_TOKEN] }));
    const tokens = data.tokens as Record<string, unknown>[];
    expect(tokens[0]).toEqual({ token: TOKEN, symbol: 'TKN', decimals: 6, raw: '2500000', formatted: '2.5' });
    expect(tokens[1]).toMatchObject({ token: OTHER_TOKEN, error: { code: 'NOT_A_CONTRACT', retryable: false } });
  });

  it('reads at a given block number', async () => {
    const h = await createHarness({ eth_getBalance: () => '0x1' });
    close = h.close;
    expectOk(await h.call('get_balance', { address: ALICE, block: 255 }));
    expect(h.rpc.calls.at(-1)?.params).toEqual([ALICE, '0xff']);
  });

  it('rejects malformed and badly checksummed addresses with INVALID_ADDRESS', async () => {
    const h = await createHarness({});
    close = h.close;
    expect(expectError(await h.call('get_balance', { address: '0x123' })).code).toBe('INVALID_ADDRESS');
    const badChecksum = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa';
    const error = expectError(await h.call('get_balance', { address: badChecksum }));
    expect(error.code).toBe('INVALID_ADDRESS');
    expect(error.message).toMatch(/checksum/);
  });
});

describe('get_token_info', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('returns name, symbol, decimals and total supply', async () => {
    const h = await createHarness({
      eth_getCode: () => '0x6080',
      eth_call: erc20Handler({ name: 'Test Token', symbol: 'TKN', decimals: 18, totalSupply: 10n ** 24n }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_token_info', { token: TOKEN }));
    expect(data).toEqual({
      token: TOKEN,
      name: 'Test Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: { raw: '1000000000000000000000000', formatted: '1000000' },
    });
  });

  it('returns null for functions the contract does not implement', async () => {
    const h = await createHarness({
      eth_getCode: () => '0x6080',
      eth_call: erc20Handler({ symbol: 'TKN', totalSupply: 5n }),
    });
    close = h.close;
    const data = expectOk(await h.call('get_token_info', { token: TOKEN }));
    expect(data).toMatchObject({
      name: null,
      symbol: 'TKN',
      decimals: null,
      totalSupply: { raw: '5', formatted: null },
    });
  });

  it('fails with NOT_A_CONTRACT for an address without code', async () => {
    const h = await createHarness({ eth_getCode: () => '0x' });
    close = h.close;
    expect(expectError(await h.call('get_token_info', { token: TOKEN })).code).toBe('NOT_A_CONTRACT');
  });

  it('fails with ABI_MISMATCH for a contract that is not an ERC-20', async () => {
    const h = await createHarness({ eth_getCode: () => '0x6080', eth_call: () => '0x' });
    close = h.close;
    expect(expectError(await h.call('get_token_info', { token: TOKEN })).code).toBe('ABI_MISMATCH');
  });

  it('surfaces RPC timeouts instead of reporting the token as non-ERC-20', async () => {
    const h = await createHarness(
      { eth_getCode: () => '0x6080', eth_call: () => HANG },
      { rpcTimeoutMs: 20, rpcRetryCount: 0 },
    );
    close = h.close;
    const error = expectError(await h.call('get_token_info', { token: TOKEN }));
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT', retryable: true });
  });
});
