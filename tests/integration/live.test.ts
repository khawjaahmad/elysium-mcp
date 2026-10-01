/**
 * Live tests against the Elysium testnet. They read real chain data, so they
 * avoid exact values and discover addresses on-chain instead of hard-coding
 * them. Set SKIP_INTEGRATION=true to skip.
 *
 * Network settings come from ELYSIUM_RPC_URL / ELYSIUM_CHAIN_ID, falling back
 * to the testnet values published at
 * https://elysium.kinetiq.xyz/docs/chain-specifications
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { formatUnits } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import type { ToolErrorPayload } from '../../src/errors.js';
import { silentLogger } from '../../src/logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';

const SKIP = ['true', '1'].includes(process.env.SKIP_INTEGRATION ?? '');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERC20_READS = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

type Result = { ok: true; data: any } | { ok: false; error: ToolErrorPayload };

describe.skipIf(SKIP)('Elysium testnet (live)', () => {
  const config = loadConfig({
    ELYSIUM_RPC_URL: 'https://testnet-rpc.elysium.kinetiq.xyz',
    ELYSIUM_CHAIN_ID: '99801',
    ...process.env,
  });
  let mcp: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Result>;

  // Discovered during the run.
  let latest: bigint;
  let sampleTx: { hash: string; from: string; to: string | null } | undefined;
  let erc20: string | undefined;
  let sequencer: string | undefined;

  const ok = (r: Result) => {
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.data;
  };

  beforeAll(async () => {
    const chain = buildChain(config);
    const limiter = new RateLimiter(config.rpcRateLimitRps);
    const client = createElysiumClient(config, chain, { limiter, logger: silentLogger });
    const server = createServer({
      client,
      config,
      guard: new ChainGuard(client, config.chainId),
      logger: silentLogger,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: 'integration', version: '0' });
    await mcp.connect(a);
    await mcp.listTools();
    call = async (name, args = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return r.isError ? { ok: false, error: JSON.parse(text).error } : { ok: true, data: r.structuredContent };
    };
  });

  afterAll(async () => mcp?.close());

  it('get_chain_status: serves chain 99801 with sub-second blocks and a base fee', async () => {
    const data = ok(await call('get_chain_status'));
    console.info('[live] chain status', JSON.stringify(data));
    expect(data.chainId).toBe(config.chainId);
    latest = BigInt(data.latestBlock.number);
    expect(latest).toBeGreaterThan(0n);
    expect(data.baseFeePerGas).not.toBeNull();
    // Docs: 100-200 ms blocks. Allow slack for load and second-granular timestamps.
    expect(data.blockTime.averageMs).toBeGreaterThan(20);
    expect(data.blockTime.averageMs).toBeLessThan(2000);
  });

  it('get_block: fetches latest, then the same block by number and by hash', async () => {
    const byTag = ok(await call('get_block', { block: 'latest' }));
    sequencer = byTag.block.miner;
    const byNumber = ok(await call('get_block', { block: Number(byTag.block.number) }));
    const byHash = ok(await call('get_block', { block: byTag.block.hash }));
    expect(byNumber.block.hash).toBe(byTag.block.hash);
    expect(byHash.block.number).toBe(byTag.block.number);
  });

  it('get_transaction: returns a recent transaction with its receipt and fee', async () => {
    for (let n = latest; n > latest - 50n && !sampleTx; n--) {
      const block = ok(await call('get_block', { block: Number(n), includeTransactions: true }));
      const tx = (block.block.transactions as { hash: string; from: string; to: string | null }[])[0];
      if (tx) sampleTx = { hash: tx.hash, from: tx.from, to: tx.to };
    }
    expect(sampleTx, 'no transactions in the last 50 blocks').toBeDefined();

    const data = ok(await call('get_transaction', { hash: sampleTx!.hash }));
    console.info('[live] sample tx', sampleTx!.hash, data.status, 'fee', JSON.stringify(data.fee));
    expect(['success', 'reverted']).toContain(data.status);
    expect(data.transaction.hash).toBe(sampleTx!.hash);
    expect(BigInt(data.fee.wei)).toBeGreaterThan(0n);
    expect(data.fee.symbol).toBe('HYPE');
  });

  it('get_balance: returns native HYPE in wei with 18-decimal formatting', async () => {
    const data = ok(await call('get_balance', { address: sampleTx!.from }));
    console.info('[live] balance of', sampleTx!.from, JSON.stringify(data.native));
    expect(data.native.symbol).toBe('HYPE');
    expect(data.native.formatted).toBe(formatUnits(BigInt(data.native.wei), 18));
  });

  it('get_logs: reads recent logs and discovers an ERC-20 transfer', async () => {
    const from = Number(latest - 500n);
    const data = ok(
      await call('get_logs', { fromBlock: from, toBlock: Number(latest), topics: [TRANSFER_TOPIC], limit: 500 }),
    );
    console.info('[live] Transfer logs in last 500 blocks:', data.totalMatched);
    // ERC-20 Transfer: 3 topics (signature, from, to) and the amount in 32 bytes of data. ERC-721 has 4 topics.
    const fungible = (data.logs as { address: string; topics: string[]; data: string }[]).find(
      (l) => l.topics.length === 3 && l.data.length === 66,
    );
    erc20 = fungible?.address;
    console.info('[live] discovered ERC-20 candidate:', erc20 ?? 'none');
  });

  it('get_token_info and read_contract: read a discovered ERC-20', async (ctx) => {
    if (!erc20) return ctx.skip();
    const info = ok(await call('get_token_info', { token: erc20 }));
    console.info('[live] token info', JSON.stringify(info));
    expect(info.token.toLowerCase()).toBe(erc20.toLowerCase());

    const decimals = ok(await call('read_contract', { address: erc20, abi: ERC20_READS, functionName: 'decimals' }));
    expect(decimals.result).toBe(info.decimals);
    const balance = ok(
      await call('read_contract', {
        address: erc20,
        abi: ERC20_READS,
        functionName: 'balanceOf',
        args: [sampleTx!.from],
      }),
    );
    expect(balance.result).toMatch(/^\d+$/);

    const viaBalance = ok(await call('get_balance', { address: sampleTx!.from, tokens: [erc20] }));
    expect(viaBalance.tokens[0].raw).toBe(balance.result);
  });

  it('simulate_call: dry-runs a zero-value HYPE transfer and estimates gas', async () => {
    const data = ok(await call('simulate_call', { from: sampleTx!.from, to: sampleTx!.from, value: '0' }));
    console.info('[live] simulate transfer', JSON.stringify({ gas: data.gasEstimate, fee: data.estimatedFee }));
    expect(data.success).toBe(true);
    expect(BigInt(data.gasEstimate)).toBeGreaterThanOrEqual(21_000n);
  });

  it('get_logs: enforces the local cap, and maps any node-side range rejection to RANGE_TOO_LARGE', async () => {
    const tooBig = await call('get_logs', {
      fromBlock: Number(latest) - config.maxLogBlockRange,
      toBlock: Number(latest),
    });
    expect(tooBig.ok ? 'ok' : tooBig.error.code).toBe('RANGE_TOO_LARGE');

    const atCap = await call('get_logs', {
      fromBlock: Number(latest) - config.maxLogBlockRange + 1,
      toBlock: Number(latest),
      limit: 1,
    });
    console.info('[live] full-cap unfiltered query:', atCap.ok ? `ok, ${atCap.data.totalMatched} logs` : atCap.error);
    if (!atCap.ok) expect(['RANGE_TOO_LARGE', 'RPC_TIMEOUT']).toContain(atCap.error.code);
  });

  it('returns typed errors for missing data', async () => {
    const missing = await call('get_transaction', { hash: `0x${'0'.repeat(63)}1` });
    expect(missing.ok ? 'ok' : missing.error.code).toBe('NOT_FOUND');

    if (sequencer) {
      const notToken = await call('get_token_info', { token: sequencer });
      expect(notToken.ok ? 'ok' : notToken.error.code).toBe('NOT_A_CONTRACT');
    }
  });
});
