/**
 * Live write tests.
 *
 * - The funded test sends a real transaction, so it runs only when
 *   ELYSIUM_TEST_PRIVATE_KEY holds a funded Elysium testnet key. It sends
 *   1 wei from that account to itself, so the only cost is the gas fee.
 * - The unfunded test always runs (unless SKIP_INTEGRATION is set). It uses a
 *   fresh throwaway key with no balance, so it can never send anything, and
 *   checks the whole path up to the balance check against the real node.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import type { ToolErrorPayload } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';

const FUNDED_KEY = process.env.ELYSIUM_TEST_PRIVATE_KEY;
const SKIP = ['true', '1'].includes(process.env.SKIP_INTEGRATION ?? '');

type Result = { ok: true; data: any } | { ok: false; error: ToolErrorPayload };

const ok = (r: Result) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
};

/** A real server with writes enabled for `key`, talking to the live testnet. */
function liveWriter(key: () => string) {
  const w = {
    logs: [] as string[],
    self: '',
    mcp: undefined as Client | undefined,
    call: async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
      const r = await w.mcp!.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return r.isError ? { ok: false, error: JSON.parse(text).error } : { ok: true, data: r.structuredContent };
    },
  };
  beforeAll(async () => {
    const config = loadConfig({
      ELYSIUM_RPC_URL: 'https://testnet-rpc.elysium.kinetiq.xyz',
      ELYSIUM_CHAIN_ID: '99801',
      ...process.env,
      ENABLE_WRITES: 'true',
      ELYSIUM_PRIVATE_KEY: key(),
      WRITE_ALLOWLIST: '',
    });
    w.self = config.writeAccount!.address;
    const logger = createLogger('debug', (line) => w.logs.push(line));
    const client = createElysiumClient(config, buildChain(config), {
      limiter: new RateLimiter(config.rpcRateLimitRps),
      logger,
    });
    const server = createServer({ client, config, guard: new ChainGuard(client, config.chainId), logger });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    w.mcp = new Client({ name: 'write-integration', version: '0' });
    await w.mcp.connect(a);
    await w.mcp.listTools();
  });
  afterAll(async () => w.mcp?.close());
  return w;
}

describe.skipIf(SKIP)('Elysium testnet writes, unfunded throwaway key (live)', () => {
  const key = generatePrivateKey();
  const w = liveWriter(() => key);

  it('runs the chain check, simulation, gas, fees and nonce live, then refuses on balance', async () => {
    const zero = await w.call('send_native', { to: w.self, value: '0' });
    console.info('[live-write] unfunded, value 0:', JSON.stringify(zero.ok ? zero.data : zero.error));
    expect(zero.ok ? 'ok' : zero.error.code).toBe('INSUFFICIENT_FUNDS');
    if (!zero.ok) expect(BigInt(zero.error.details!.required as string)).toBeGreaterThan(0n);

    // With a value, the node itself rejects the simulation; its wording must map to the same code.
    const one = await w.call('send_native', { to: w.self, value: '1', dry_run: false });
    console.info('[live-write] unfunded, value 1:', JSON.stringify(one.ok ? one.data : one.error));
    expect(one.ok ? 'ok' : one.error.code).toBe('INSUFFICIENT_FUNDS');

    const haystack = (JSON.stringify([zero, one]) + w.logs.join('\n')).toLowerCase();
    expect(haystack).not.toContain(key.slice(2).toLowerCase());
  });
});

describe.skipIf(SKIP || !FUNDED_KEY)('Elysium testnet writes, funded key (live)', () => {
  const w = liveWriter(() => FUNDED_KEY!);
  const { call } = w;

  it('send_native: previews, then sends 1 wei to itself and reports the receipt', async () => {
    const preview = ok(await call('send_native', { to: w.self, value: '1' }));
    console.info('[live-write] dry run', JSON.stringify(preview.transaction));
    expect(preview).toMatchObject({ status: 'dry_run', hash: null, transaction: { chainId: 99801, from: w.self } });

    const sent = ok(await call('send_native', { to: w.self, value: '1', dry_run: false }));
    console.info('[live-write] sent', JSON.stringify({ status: sent.status, hash: sent.hash, receipt: sent.receipt }));
    expect(sent.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.status).toBe('success');
    expect(BigInt(sent.receipt.gasUsed)).toBeGreaterThanOrEqual(21_000n);
    expect(BigInt(sent.receipt.fee.wei)).toBeGreaterThan(0n);

    const tx = ok(await call('get_transaction', { hash: sent.hash }));
    expect(tx.from.toLowerCase()).toBe(w.self.toLowerCase());

    const haystack = (JSON.stringify([preview, sent, tx]) + w.logs.join('\n')).toLowerCase();
    expect(haystack).not.toContain(FUNDED_KEY!.replace(/^0x/, '').toLowerCase());
  });
});
