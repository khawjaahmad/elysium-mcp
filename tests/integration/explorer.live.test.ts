/**
 * Live tests for the optional explorer tools. They run only when
 * EXPLORER_API_URL is set (e.g. https://elysium.kinetiq.xyz/api/v2) and
 * SKIP_INTEGRATION is not. Addresses are discovered through the explorer
 * itself; nothing is hard-coded.
 *
 * Each test finds its own input, so one slow endpoint fails only its own
 * test. Token and holder come from the explorer's list endpoints (not from
 * explorer_search) through a shared, retried discovery step.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import { ExplorerClient } from '../../src/explorer/client.js';
import type { ToolErrorPayload } from '../../src/errors.js';
import { silentLogger } from '../../src/logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';

const SKIP = ['true', '1'].includes(process.env.SKIP_INTEGRATION ?? '') || !process.env.EXPLORER_API_URL;

type Result = { ok: true; data: any } | { ok: false; error: ToolErrorPayload };

const list = z.object({ items: z.array(z.any()) });

describe.skipIf(SKIP)('Elysium explorer (live)', () => {
  const config = loadConfig({
    ELYSIUM_RPC_URL: 'https://testnet-rpc.elysium.kinetiq.xyz',
    ELYSIUM_CHAIN_ID: '99801',
    ...process.env,
  });
  let mcp: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  const ok = (r: Result) => {
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.data;
  };

  // A separate client with more retries than the default, used only to find test inputs.
  const discovery = new ExplorerClient(
    config.explorerApiUrl!,
    { ...config, explorerRetryCount: 4 },
    { logger: silentLogger },
  );
  // Found once and shared. A failed attempt is not cached, so the next test tries again.
  let inputs: Promise<{ token: string; holder: string }> | undefined;
  const tokenAndHolder = () =>
    (inputs ??= (async () => {
      const tokens = await discovery.get('/tokens', list, { type: 'ERC-20' });
      const token: string | undefined = tokens.items.find((t) => Number(t.holders_count) > 0)?.address_hash;
      if (!token) throw new Error('The explorer lists no ERC-20 token with holders (/tokens?type=ERC-20).');
      const holders = await discovery.get(`/tokens/${token}/holders`, list);
      const holder: string | undefined = holders.items[0]?.address?.hash;
      if (!holder) throw new Error(`The explorer lists no holders for token ${token}.`);
      return { token, holder };
    })().catch((err) => {
      inputs = undefined;
      throw err;
    }));

  beforeAll(async () => {
    const client = createElysiumClient(config, buildChain(config), {
      limiter: new RateLimiter(config.rpcRateLimitRps),
      logger: silentLogger,
    });
    const explorer = new ExplorerClient(config.explorerApiUrl!, config, { logger: silentLogger });
    const server = createServer({
      client,
      config,
      guard: new ChainGuard(client, config.chainId),
      logger: silentLogger,
      explorer,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: 'explorer-integration', version: '0' });
    await mcp.connect(a);
    await mcp.listTools(); // enables client-side output-schema validation
    call = async (name, args = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return r.isError ? { ok: false, error: JSON.parse(text).error } : { ok: true, data: r.structuredContent };
    };
  });

  afterAll(async () => mcp?.close());

  it('explorer_search finds tokens with verification and holder counts', async () => {
    const data = ok(await call('explorer_search', { query: 'Elysium' }));
    const tokens = (data.items as any[]).filter((i) => i.type === 'token');
    console.info('[live-explorer] search "Elysium":', JSON.stringify(tokens.slice(0, 3)));
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('explorer_get_token returns the token and a page of holders', async () => {
    const { token } = await tokenAndHolder();
    const data = ok(await call('explorer_get_token', { token, includeHolders: true }));
    console.info('[live-explorer] token', JSON.stringify(data.token));
    expect(data.token.address.toLowerCase()).toBe(token.toLowerCase());
    expect(data.holders.items[0]?.holder.address).toBeDefined();
  });

  it('explorer_get_address: indexed balance is labelled, and get_balance reads the chain', async () => {
    const { holder } = await tokenAndHolder();
    const data = ok(await call('explorer_get_address', { address: holder }));
    const rpc = ok(await call('get_balance', { address: holder }));
    console.info(
      '[live-explorer] indexed vs RPC balance',
      JSON.stringify({ indexed: data.indexedBalance, rpc: rpc.native }),
    );
    expect((data.notices as string[]).join(' ')).toMatch(/may lag/);
  });

  it('explorer_get_token_balances and explorer_get_token_transfers return pages', async () => {
    const { holder } = await tokenAndHolder();
    const balances = ok(await call('explorer_get_token_balances', { address: holder }));
    const transfers = ok(await call('explorer_get_token_transfers', { address: holder }));
    console.info('[live-explorer] balances', balances.items.length, 'transfers', transfers.items.length);
    expect(Array.isArray(balances.items)).toBe(true);
    expect(Array.isArray(transfers.items)).toBe(true);
  });

  it('explorer_get_address_transactions follows the cursor to a second page', async (ctx) => {
    const { holder } = await tokenAndHolder();
    const first = ok(await call('explorer_get_address_transactions', { address: holder }));
    console.info('[live-explorer] tx page 1:', first.items.length, 'items, nextCursor:', first.nextCursor !== null);
    if (!first.nextCursor) return ctx.skip();
    const second = ok(await call('explorer_get_address_transactions', { address: holder, cursor: first.nextCursor }));
    expect(second.items[0]?.hash).not.toBe(first.items[0]?.hash);
  });

  it('explorer_get_contract returns a usable ABI for a verified contract', async () => {
    const verified = await discovery.get('/smart-contracts', list, { filter: 'verified' });
    const address: string | undefined = verified.items[0]?.address?.hash;
    if (!address) {
      throw new Error(
        'The explorer lists no verified contracts (/smart-contracts?filter=verified is empty), ' +
          'so explorer_get_contract cannot be tested.',
      );
    }
    const data = ok(await call('explorer_get_contract', { address }));
    console.info(
      '[live-explorer] contract',
      address,
      JSON.stringify({ name: data.untrusted.name, abiItems: data.untrusted.abi?.length, proxy: data.proxy }),
    );
    expect(data.untrusted.abi?.length).toBeGreaterThan(0);
    expect(data.verification.meaning).toMatch(/does not mean the contract is safe/);
  });
});
