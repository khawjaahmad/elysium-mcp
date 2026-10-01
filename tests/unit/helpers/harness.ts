import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublicClient } from 'viem';
import { buildChain } from '../../../src/chain.js';
import { loadConfig, type Config } from '../../../src/config.js';
import type { ToolErrorPayload } from '../../../src/errors.js';
import { silentLogger } from '../../../src/logger.js';
import { ChainGuard, RateLimiter, resilientHttp } from '../../../src/rpc.js';
import { createServer } from '../../../src/server.js';
import { mockRpc, TESTNET_CHAIN_ID, type Handler } from './rpc.js';

export const TEST_ENV = {
  ELYSIUM_RPC_URL: 'https://rpc.test.invalid',
  ELYSIUM_CHAIN_ID: String(TESTNET_CHAIN_ID),
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig(TEST_ENV), ...overrides };
}

export type CallResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolErrorPayload };

/**
 * Wires the real MCP server, real viem client and real transport to a mock
 * JSON-RPC node, and connects an MCP client over an in-memory transport.
 */
export async function createHarness(handlers: Record<string, Handler>, overrides: Partial<Config> = {}) {
  const config = testConfig({ rpcRetryBaseDelayMs: 1, rpcTimeoutMs: 200, ...overrides });
  const rpc = mockRpc(handlers);
  const chain = buildChain(config);
  const client = createPublicClient({
    chain,
    transport: resilientHttp(config, { limiter: new RateLimiter(10_000), fetchFn: rpc.fetchFn, sleep: async () => {} }),
  });
  const server = createServer({ client, config, guard: new ChainGuard(client, config.chainId), logger: silentLogger });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientTransport);
  // Listing tools makes the client validate structured output against each outputSchema.
  await mcp.listTools();

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    if (result.isError) {
      try {
        return { ok: false, error: (JSON.parse(text) as { error: ToolErrorPayload }).error };
      } catch {
        // Errors raised by the SDK itself (e.g. schema validation) are plain text.
        return { ok: false, error: { code: 'INVALID_INPUT', message: text, retryable: false } };
      }
    }
    return { ok: true, data: result.structuredContent as Record<string, unknown> };
  }

  return {
    call,
    rpc,
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

/** Narrows a CallResult to success, failing the test with the error otherwise. */
export function expectOk(result: CallResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

export function expectError(result: CallResult): ToolErrorPayload {
  if (result.ok) throw new Error(`Expected an error, got ${JSON.stringify(result.data)}`);
  return result.error;
}
