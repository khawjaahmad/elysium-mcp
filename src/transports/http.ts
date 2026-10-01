import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isLoopbackHost } from '../config.js';
import type { Logger } from '../logger.js';

const MAX_BODY_BYTES = 1024 * 1024;
export const MCP_PATH = '/mcp';

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string | undefined;
  logger: Logger;
  /** Builds a fresh MCP server per request (stateless mode). */
  createMcpServer: () => McpServer;
}

export interface RunningHttpServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time bearer token check. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!.trim()), digest(token));
}

/** Hostname part of a Host header ("localhost:3000" -> "localhost", "[::1]:3000" -> "::1"). */
function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return '';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Streamable HTTP transport in stateless mode: each POST to /mcp gets its own
 * MCP server and transport. When bound to loopback, Host and Origin headers
 * must also be loopback, which blocks DNS-rebinding attacks from web pages.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const loopback = isLoopbackHost(opts.host);

  const server = createHttpServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' });
    if (path !== MCP_PATH) return sendJson(res, 404, { error: 'not found' });

    if (loopback) {
      if (!isLoopbackHost(hostnameOf(req.headers.host ?? ''))) {
        return jsonRpcError(res, 403, -32000, 'Forbidden: Host header must be a loopback address.');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null') {
        let originHost = '';
        try {
          originHost = new URL(origin).hostname;
        } catch {
          /* invalid origin -> rejected below */
        }
        if (!isLoopbackHost(originHost)) return jsonRpcError(res, 403, -32000, 'Forbidden: cross-origin request.');
      }
    }

    if (opts.token !== undefined && !isAuthorized(req.headers.authorization, opts.token)) {
      return jsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid bearer token.', {
        'www-authenticate': 'Bearer',
      });
    }

    if (req.method !== 'POST') {
      return jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless; use POST.', {
        allow: 'POST',
      });
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return err instanceof RangeError
        ? jsonRpcError(res, 413, -32600, 'Request body too large.')
        : jsonRpcError(res, 400, -32700, 'Parse error: body is not valid JSON.');
    }

    const mcp = opts.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      opts.logger.error(`HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error.');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const hostForUrl = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return {
    server,
    url: `http://${hostForUrl}:${port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
