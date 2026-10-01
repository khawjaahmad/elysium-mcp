import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from './tools/define.js';
import { READ_TOOLS } from './tools/index.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const INSTRUCTIONS = `Read-only access to Elysium, Kinetiq's Arbitrum Orbit Layer 2 for Hyperliquid. The native gas token is HYPE (18 decimals; amounts in wei are integers as decimal strings).
- Start with get_chain_status to see the latest block.
- Callers must supply contract addresses and ABIs; this server does not look them up.
- get_logs ranges are capped; split long ranges.
- Errors are JSON {error: {code, message, retryable, hint}}. Retry only when retryable is true.`;

/** Creates an MCP server with every tool registered against `ctx`. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, READ_TOOLS, ctx);
  return server;
}
