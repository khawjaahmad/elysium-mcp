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
import { formatUnits, numberToHex, type PublicClient } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import { rpcCode, rpcMessage, revertDataFrom, type ToolErrorPayload } from '../../src/errors.js';
import { silentLogger } from '../../src/logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';
import { classifyGetLogsError } from '../../src/tools/getLogs.js';

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
  let rawClient: PublicClient;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Result>;

  // Discovered during the run.
  let latest: bigint;
  // Picked by the type the RPC reports, not by position in the block.
  let systemTx: { hash: string; from: string } | undefined;
  let userTx: { hash: string; from: string } | undefined;
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
    rawClient = client;
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

  it('get_block: finds recent ArbOS system and user transactions by their on-chain type', async () => {
    const seenTypes = new Set<string>();
    for (let n = latest; n > latest - 200n && !(systemTx && userTx); n--) {
      const block = ok(await call('get_block', { block: Number(n), includeTransactions: true }));
      for (const tx of block.block.transactions as { hash: string; from: string; typeHex?: string }[]) {
        const code = tx.typeHex === undefined ? NaN : Number.parseInt(tx.typeHex, 16);
        seenTypes.add(String(tx.typeHex));
        if (code === 106) systemTx ??= { hash: tx.hash, from: tx.from };
        else if (code >= 0 && code <= 4) userTx ??= { hash: tx.hash, from: tx.from };
      }
    }
    console.info('[live] transaction types seen (raw RPC typeHex):', [...seenTypes].join(', '));
    console.info('[live] system tx:', JSON.stringify(systemTx), 'user tx:', JSON.stringify(userTx));
    expect(systemTx, 'no ArbOS internal (type 0x6a) transaction in the last 200 blocks').toBeDefined();
    expect(userTx, 'no user (type 0x0-0x4) transaction in the last 200 blocks').toBeDefined();
  });

  it('get_transaction: flags an ArbOS internal transaction as a zero-fee system transaction', async () => {
    const data = ok(await call('get_transaction', { hash: systemTx!.hash }));
    console.info(
      '[live] system tx',
      systemTx!.hash,
      JSON.stringify({ type: data.transactionType, fee: data.fee, note: data.note }),
    );
    expect(data.transaction.typeHex).toBe('0x6a');
    expect(data.transactionType).toEqual({ code: 106, name: 'ArbitrumInternalTx', origin: 'arbos' });
    expect(data.systemTransaction).toBe(true);
    expect(data.fee.wei).toBe('0');
  });

  it('get_transaction: returns a user transaction with a real, non-zero fee in HYPE', async () => {
    const data = ok(await call('get_transaction', { hash: userTx!.hash }));
    const gasUsed = BigInt(data.receipt.gasUsed);
    const effectiveGasPrice = BigInt(data.receipt.effectiveGasPrice);
    const block = ok(await call('get_block', { block: Number(data.receipt.blockNumber) }));
    console.info(
      '[live] user tx',
      userTx!.hash,
      JSON.stringify({
        type: data.transactionType,
        status: data.status,
        gasUsed: gasUsed.toString(),
        effectiveGasPriceWei: effectiveGasPrice.toString(),
        blockBaseFeeWei: block.block.baseFeePerGas,
        fee: data.fee,
      }),
    );
    expect(data.systemTransaction).toBe(false);
    expect(data.transactionType.origin).toBe('user');
    expect(['success', 'reverted']).toContain(data.status);
    // The fee is gasUsed x effectiveGasPrice in wei, paid at no less than the block's base fee,
    // and shown in HYPE using 18 decimals.
    expect(gasUsed).toBeGreaterThan(0n);
    expect(effectiveGasPrice).toBeGreaterThanOrEqual(BigInt(block.block.baseFeePerGas));
    expect(BigInt(data.fee.wei)).toBe(gasUsed * effectiveGasPrice);
    expect(BigInt(data.fee.wei)).toBeGreaterThan(0n);
    expect(data.fee.formatted).toBe(formatUnits(gasUsed * effectiveGasPrice, 18));
    expect(data.fee.symbol).toBe('HYPE');
  });

  it('get_balance: an address that pays fees holds HYPE, shown with 18 decimals', async () => {
    const data = ok(await call('get_balance', { address: userTx!.from }));
    console.info('[live] balance of fee payer', userTx!.from, JSON.stringify(data.native));
    expect(BigInt(data.native.wei)).toBeGreaterThan(0n);
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
        args: [userTx!.from],
      }),
    );
    expect(balance.result).toMatch(/^\d+$/);

    const viaBalance = ok(await call('get_balance', { address: userTx!.from, tokens: [erc20] }));
    expect(viaBalance.tokens[0].raw).toBe(balance.result);
  });

  it('simulate_call: dry-runs a zero-value HYPE transfer and estimates gas', async () => {
    const data = ok(await call('simulate_call', { from: userTx!.from, to: userTx!.from, value: '0' }));
    expect(data.success).toBe(true);
    expect(BigInt(data.gasEstimate)).toBeGreaterThanOrEqual(21_000n);
  });

  it('simulate_call: reports a revert for a call to an ArbOS address', async () => {
    // ArbOS addresses hold the placeholder code 0xfe (INVALID), so any call to one reverts.
    const data = ok(await call('simulate_call', { from: systemTx!.from, to: systemTx!.from, value: '0' }));
    expect(data.success).toBe(false);
    expect(data.revert).not.toBeNull();
    expect(data.gasEstimate).toBeNull();
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

  it('diagnostic: records what the RPC itself returns for oversized eth_getLogs queries', async () => {
    // Bypasses the tool's local cap and talks to the node directly, so the
    // node's own limits and error wording are observed rather than assumed.
    const NO_MATCH_TOPIC = `0x${'0'.repeat(64)}`;
    const probes = [
      // Whole chain, with a topic that matches nothing: exercises a block-range limit without a big response.
      { label: 'whole chain, no-match topic', fromBlock: 0n, topics: [NO_MATCH_TOPIC] },
      // 100k blocks of Transfer logs: exercises a result-count / response-size limit.
      {
        label: '100k blocks, Transfer topic',
        fromBlock: latest > 100_000n ? latest - 99_999n : 0n,
        topics: [TRANSFER_TOPIC],
      },
    ];
    for (const probe of probes) {
      const span = latest - probe.fromBlock + 1n;
      try {
        const logs = (await rawClient.request({
          method: 'eth_getLogs',
          params: [{ fromBlock: numberToHex(probe.fromBlock), toBlock: numberToHex(latest), topics: probe.topics }],
        } as never)) as unknown[];
        console.info(`[live] RPC ACCEPTED eth_getLogs (${probe.label}, ${span} blocks): ${logs.length} logs`);
      } catch (err) {
        const mapped = classifyGetLogsError(err, probe.fromBlock, latest);
        console.info(
          `[live] RPC REJECTED eth_getLogs (${probe.label}, ${span} blocks):`,
          JSON.stringify({
            rpcCode: rpcCode(err),
            rpcMessage: rpcMessage(err),
            rpcData: revertDataFrom(err),
            mappedTo: mapped.code,
          }),
        );
        // A node-side rejection that is not a transport problem must be recognised as RANGE_TOO_LARGE.
        if (!mapped.retryable)
          expect(mapped.code, `unrecognised node wording: ${rpcMessage(err)}`).toBe('RANGE_TOO_LARGE');
      }
    }
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
