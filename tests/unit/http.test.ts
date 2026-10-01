import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'node:http';
import { createPublicClient } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain.js';
import { silentLogger } from '../../src/logger.js';
import { ChainGuard, RateLimiter, resilientHttp } from '../../src/rpc.js';
import { createServer } from '../../src/server.js';
import { isAuthorized, startHttpServer, type RunningHttpServer } from '../../src/transports/http.js';
import { testConfig } from './helpers/harness.js';
import { mockRpc } from './helpers/rpc.js';

const TOKEN = 'test-token-0123456789';

async function start(token?: string): Promise<RunningHttpServer> {
  const config = testConfig();
  const rpc = mockRpc({ eth_blockNumber: () => '0x1' });
  const client = createPublicClient({
    chain: buildChain(config),
    transport: resilientHttp(config, { limiter: new RateLimiter(1000), fetchFn: rpc.fetchFn }),
  });
  const ctx = { client, config, guard: new ChainGuard(client, config.chainId), logger: silentLogger };
  return startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token,
    logger: silentLogger,
    createMcpServer: () => createServer(ctx),
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

/** Raw request so the Host header can be forged (fetch does not allow that). */
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

describe('HTTP transport', () => {
  let server: RunningHttpServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves MCP over streamable HTTP and lists all eight tools', async () => {
    server = await start();
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_balance',
      'get_block',
      'get_chain_status',
      'get_logs',
      'get_token_info',
      'get_transaction',
      'read_contract',
      'simulate_call',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it('requires the bearer token when one is configured', async () => {
    server = await start(TOKEN);
    expect((await rawPost(server.url, {}, INIT)).status).toBe(401);
    expect((await rawPost(server.url, { authorization: 'Bearer wrong-token-000000' }, INIT)).status).toBe(401);
    expect((await rawPost(server.url, { authorization: `Bearer ${TOKEN}` }, INIT)).status).toBe(200);

    const client = new Client({ name: 't', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(8);
    await client.close();
  });

  it('blocks DNS-rebinding style requests with a foreign Host or Origin on loopback', async () => {
    server = await start();
    expect((await rawPost(server.url, { host: 'evil.example.com' }, INIT)).status).toBe(403);
    expect((await rawPost(server.url, { origin: 'https://evil.example.com' }, INIT)).status).toBe(403);
    expect((await rawPost(server.url, { origin: 'http://localhost:5173' }, INIT)).status).toBe(200);
  });

  it('answers malformed bodies, wrong paths and GET with proper statuses', async () => {
    server = await start();
    expect((await rawPost(server.url, {}, '{not json')).status).toBe(400);
    expect((await fetch(server.url.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(server.url)).status).toBe(405);
    expect(await (await fetch(server.url.replace('/mcp', '/health'))).json()).toEqual({ status: 'ok' });
  });
});

describe('isAuthorized', () => {
  it('accepts only the exact bearer token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
  });
});
