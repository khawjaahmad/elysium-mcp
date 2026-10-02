import { isIP } from 'node:net';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  ELYSIUM_RPC_URL: z
    .string({ error: 'is required (the JSON-RPC endpoint URL)' })
    .pipe(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })),
  ELYSIUM_CHAIN_ID: z
    .string({ error: 'is required (the chain ID the RPC endpoint must serve)' })
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .transform(Number),
  ELYSIUM_CHAIN_NAME: z.string().min(1).default('Elysium'),

  RPC_TIMEOUT_MS: positiveInt(10_000),
  RPC_RETRY_COUNT: z.coerce.number().int().min(0).max(10).default(3),
  RPC_RETRY_BASE_DELAY_MS: positiveInt(250),
  RPC_RATE_LIMIT_RPS: z.coerce.number().positive().default(10),
  MAX_LOG_BLOCK_RANGE: positiveInt(10_000),
  BLOCK_TIME_SAMPLE_SIZE: z.coerce.number().int().min(1).max(100_000).default(1000),

  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  MCP_HTTP_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .refine((v) => v === undefined || v.length >= 16, 'must be at least 16 characters'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Optional explorer tools. No default: they are only enabled when this is set.
  EXPLORER_API_URL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .pipe(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional()),
  EXPLORER_TIMEOUT_MS: positiveInt(10_000),
  EXPLORER_RETRY_COUNT: z.coerce.number().int().min(0).max(10).default(2),
  EXPLORER_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),

  ENABLE_WRITES: bool,
});

export interface Config {
  rpcUrl: string;
  chainId: number;
  chainName: string;
  rpcTimeoutMs: number;
  rpcRetryCount: number;
  rpcRetryBaseDelayMs: number;
  rpcRateLimitRps: number;
  maxLogBlockRange: number;
  blockTimeSampleSize: number;
  transport: 'stdio' | 'http';
  httpHost: string;
  httpPort: number;
  httpToken: string | undefined;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableWrites: boolean;
  explorerApiUrl: string | undefined;
  explorerTimeoutMs: number;
  explorerRetryCount: number;
  explorerRateLimitRps: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** True for localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

/** Parses and validates configuration from environment variables. Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;

  const config: Config = {
    rpcUrl: e.ELYSIUM_RPC_URL,
    chainId: e.ELYSIUM_CHAIN_ID,
    chainName: e.ELYSIUM_CHAIN_NAME,
    rpcTimeoutMs: e.RPC_TIMEOUT_MS,
    rpcRetryCount: e.RPC_RETRY_COUNT,
    rpcRetryBaseDelayMs: e.RPC_RETRY_BASE_DELAY_MS,
    rpcRateLimitRps: e.RPC_RATE_LIMIT_RPS,
    maxLogBlockRange: e.MAX_LOG_BLOCK_RANGE,
    blockTimeSampleSize: e.BLOCK_TIME_SAMPLE_SIZE,
    transport: e.MCP_TRANSPORT,
    httpHost: e.MCP_HTTP_HOST,
    httpPort: e.MCP_HTTP_PORT,
    httpToken: e.MCP_HTTP_TOKEN,
    logLevel: e.LOG_LEVEL,
    enableWrites: e.ENABLE_WRITES,
    explorerApiUrl: e.EXPLORER_API_URL,
    explorerTimeoutMs: e.EXPLORER_TIMEOUT_MS,
    explorerRetryCount: e.EXPLORER_RETRY_COUNT,
    explorerRateLimitRps: e.EXPLORER_RATE_LIMIT_RPS,
  };

  if (config.transport === 'http') {
    if (!config.httpToken && !isLoopbackHost(config.httpHost)) {
      throw new ConfigError(
        `MCP_HTTP_HOST=${config.httpHost} is not a loopback address, so MCP_HTTP_TOKEN must be set.`,
      );
    }
    if (!config.httpToken && config.enableWrites) {
      throw new ConfigError('ENABLE_WRITES=true over HTTP requires MCP_HTTP_TOKEN to be set.');
    }
  }

  return config;
}

/** RPC URL reduced to its origin, so API keys in paths or queries never reach logs. */
export function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
}
