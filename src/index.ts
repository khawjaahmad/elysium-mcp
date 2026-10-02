#!/usr/bin/env node
import { formatEther } from 'viem';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildChain } from './chain.js';
import { ExplorerClient } from './explorer/client.js';
import { loadConfig, redactUrl, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { ChainGuard, createElysiumClient, RateLimiter } from './rpc.js';
import { createServer } from './server.js';
import type { ToolContext } from './tools/define.js';
import { startHttpServer } from './transports/http.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

function buildContext(config: Config, logger: Logger): ToolContext {
  const chain = buildChain(config);
  const limiter = new RateLimiter(config.rpcRateLimitRps);
  const client = createElysiumClient(config, chain, { limiter, logger });
  const explorer = config.explorerApiUrl ? new ExplorerClient(config.explorerApiUrl, config, { logger }) : undefined;
  return { client, config, guard: new ChainGuard(client, config.chainId), logger, ...(explorer ? { explorer } : {}) };
}

/** Verifies the chain ID at startup. A mismatch is fatal; an unreachable RPC is retried on the first tool call. */
async function verifyChain(ctx: ToolContext): Promise<void> {
  try {
    await ctx.guard.ensure();
    ctx.logger.info(`Connected to chain ${ctx.config.chainId} at ${redactUrl(ctx.config.rpcUrl)}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'CHAIN_MISMATCH') throw err;
    ctx.logger.warn(`Could not verify chain ID at startup (${(err as Error).message}); will retry on first tool call.`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(`${SERVER_NAME} ${SERVER_VERSION} starting (transport=${config.transport})`);
  if (config.explorerApiUrl) {
    logger.info(`Explorer tools enabled at ${redactUrl(config.explorerApiUrl)} (undocumented API)`);
  }
  // Nothing in this process needs the raw key after loadConfig; keep it out of the environment.
  delete process.env.ELYSIUM_PRIVATE_KEY;
  if (config.writeAccount) {
    logger.warn(
      `Write tools ENABLED: sending from ${config.writeAccount.address} on chain ${config.chainId}; ` +
        `MAX_SEND_HYPE=${formatEther(config.maxSendWei)}, MAX_FEE_HYPE=${formatEther(config.maxFeeWei)}, ` +
        `WRITE_ALLOWLIST=${config.writeAllowlist ? config.writeAllowlist.join(',') : 'unset (any address)'}`,
    );
    if (config.explorerApiUrl) {
      logger.warn(
        'Write tools and explorer tools are both enabled. Explorer data is third-party text that could carry ' +
          'instructions aimed at the agent (prompt injection); keep tool-call approval on for the write tools.',
      );
    }
  }

  const ctx = buildContext(config, logger);
  await verifyChain(ctx);

  if (config.transport === 'stdio') {
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return;
  }

  const http = await startHttpServer({
    host: config.httpHost,
    port: config.httpPort,
    token: config.httpToken,
    logger,
    createMcpServer: () => createServer(ctx),
  });
  logger.info(`Listening on ${http.url}${config.httpToken ? ' (bearer token required)' : ''}`);
  const shutdown = async () => {
    await http.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
