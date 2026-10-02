import { isIP } from 'node:net';
import { getAddress, isAddress, parseEther, type Address } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { z } from 'zod';
import { ELYSIUM_TESTNET_CHAIN_ID } from './chain.js';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** A HYPE amount such as "0.01", converted to wei. */
const hypeAmount = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((v) => /^\d+(\.\d{1,18})?$/.test(v), 'must be a HYPE amount such as 0.01 (at most 18 decimals)')
    .transform((v) => parseEther(v));

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
  MAX_LOG_BLOCK_RANGE: positiveInt(2_000),
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
  // Never echoed back: validated by hand in loadConfig so no error message can contain it.
  ELYSIUM_PRIVATE_KEY: z.string().optional(),
  MAX_SEND_HYPE: hypeAmount('0.01'),
  MAX_FEE_HYPE: hypeAmount('0.001'),
  WRITE_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.split(',').map((a) => a.trim())))
    .refine((list) => list === undefined || list.every((a) => isAddress(a)), 'must be comma-separated 0x addresses')
    .transform((list) => list?.map((a) => getAddress(a))),
  WRITE_RECEIPT_TIMEOUT_MS: positiveInt(30_000),
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
  /** Signs write transactions. Set only when writes are enabled. Holds no readable copy of the key. */
  writeAccount: LocalAccount | undefined;
  /** Per-transaction cap on the HYPE value sent, in wei. */
  maxSendWei: bigint;
  /** Per-transaction cap on gas limit × max fee per gas, in wei. */
  maxFeeWei: bigint;
  /** When set, the only addresses write tools may send to or call. */
  writeAllowlist: Address[] | undefined;
  writeReceiptTimeoutMs: number;
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
    writeAccount: e.ENABLE_WRITES ? loadWriteAccount(e.ELYSIUM_PRIVATE_KEY) : undefined,
    maxSendWei: e.MAX_SEND_HYPE,
    maxFeeWei: e.MAX_FEE_HYPE,
    writeAllowlist: e.WRITE_ALLOWLIST,
    writeReceiptTimeoutMs: e.WRITE_RECEIPT_TIMEOUT_MS,
    explorerApiUrl: e.EXPLORER_API_URL,
    explorerTimeoutMs: e.EXPLORER_TIMEOUT_MS,
    explorerRetryCount: e.EXPLORER_RETRY_COUNT,
    explorerRateLimitRps: e.EXPLORER_RATE_LIMIT_RPS,
  };

  if (config.enableWrites && config.chainId !== ELYSIUM_TESTNET_CHAIN_ID) {
    throw new ConfigError(
      `ENABLE_WRITES=true is only allowed on chain ${ELYSIUM_TESTNET_CHAIN_ID} (Elysium testnet); ELYSIUM_CHAIN_ID is ${config.chainId}.`,
    );
  }

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

/**
 * Turns ELYSIUM_PRIVATE_KEY into a signing account. Error messages never
 * include the value, and the cause is dropped so it cannot leak through one.
 */
function loadWriteAccount(key: string | undefined): LocalAccount {
  if (key === undefined || key === '') {
    throw new ConfigError('ENABLE_WRITES=true requires ELYSIUM_PRIVATE_KEY to be set.');
  }
  const hex = key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ConfigError('ELYSIUM_PRIVATE_KEY must be 32 bytes of hex (64 hex characters, optionally 0x-prefixed).');
  }
  try {
    return privateKeyToAccount(hex as `0x${string}`);
  } catch {
    throw new ConfigError('ELYSIUM_PRIVATE_KEY is not a valid secp256k1 private key.');
  }
}

/** RPC URL reduced to its origin, so API keys in paths or queries never reach logs. */
export function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
}
