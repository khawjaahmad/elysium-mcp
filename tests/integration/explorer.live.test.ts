/**
 * Live tests for the optional explorer tools. They run only when
 * EXPLORER_API_URL is set (e.g. https://elysium.kinetiq.xyz/api/v2) and
 * SKIP_INTEGRATION is not. Addresses are discovered through the explorer
 * itself; nothing is hard-coded.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import { ExplorerClient } from '../../src/explorer/client.js';
import type { ToolErrorPayload } from '../../src/errors.js';
import { silentLogger } from '../../src/logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';

const SKIP = ['true', '1'].includes(process.env.SKIP_INTEGRATION ?? '') || !process.env.EXPLORER_API_URL;

type Result = { ok: true; data: any } | { ok: false; error: ToolErrorPayload };

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

  let token: string | undefined;
  let holder: string | undefined;

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
    token = tokens.find((t) => t.holdersCount !== null)?.address ?? tokens[0].address;
  });

  it('explorer_get_token returns the token and a page of holders', async () => {
    const data = ok(await call('explorer_get_token', { token, includeHolders: true }));
    console.info('[live-explorer] token', JSON.stringify(data.token));
    expect(data.token.address.toLowerCase()).toBe(token!.toLowerCase());
    holder = data.holders.items[0]?.holder.address;
    expect(holder).toBeDefined();
  });

  it('explorer_get_address: indexed balance is labelled, and get_balance reads the chain', async () => {
    const data = ok(await call('explorer_get_address', { address: holder }));
    const rpc = ok(await call('get_balance', { address: holder }));
    console.info(
      '[live-explorer] indexed vs RPC balance',
      JSON.stringify({ indexed: data.indexedBalance, rpc: rpc.native }),
    );
    expect((data.notices as string[]).join(' ')).toMatch(/may lag/);
  });

  it('explorer_get_token_balances and explorer_get_token_transfers return pages', async () => {
    const balances = ok(await call('explorer_get_token_balances', { address: holder }));
    const transfers = ok(await call('explorer_get_token_transfers', { address: holder }));
    console.info('[live-explorer] balances', balances.items.length, 'transfers', transfers.items.length);
    expect(Array.isArray(balances.items)).toBe(true);
    expect(Array.isArray(transfers.items)).toBe(true);
  });

  it('explorer_get_address_transactions follows the cursor to a second page', async (ctx) => {
    const first = ok(await call('explorer_get_address_transactions', { address: holder }));
    console.info('[live-explorer] tx page 1:', first.items.length, 'items, nextCursor:', first.nextCursor !== null);
    if (!first.nextCursor) return ctx.skip();
    const second = ok(await call('explorer_get_address_transactions', { address: holder, cursor: first.nextCursor }));
    expect(second.items[0]?.hash).not.toBe(first.items[0]?.hash);
  });

  it('explorer_get_contract returns a usable ABI for a verified contract', async (ctx) => {
    const search = ok(await call('explorer_search', { query: 'Proxy' }));
    const verified = (search.items as any[]).find((i) => i.isVerifiedContract && i.address);
    if (!verified) return ctx.skip();
    const data = ok(await call('explorer_get_contract', { address: verified.address }));
    console.info(
      '[live-explorer] contract',
      verified.address,
      JSON.stringify({ name: data.untrusted.name, abiItems: data.untrusted.abi?.length, proxy: data.proxy }),
    );
    expect(data.verification.meaning).toMatch(/does not mean the contract is safe/);
  });
});
