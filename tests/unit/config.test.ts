import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig, redactUrl } from '../../src/config.js';

const BASE = { ELYSIUM_RPC_URL: 'https://testnet-rpc.elysium.kinetiq.xyz', ELYSIUM_CHAIN_ID: '99801' };
const TOKEN = 'a-sufficiently-long-token';

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      rpcUrl: BASE.ELYSIUM_RPC_URL,
      chainId: 99801,
      chainName: 'Elysium',
      rpcTimeoutMs: 10_000,
      rpcRetryCount: 3,
      rpcRetryBaseDelayMs: 250,
      rpcRateLimitRps: 10,
      maxLogBlockRange: 2_000,
      blockTimeSampleSize: 1000,
      transport: 'stdio',
      httpHost: '127.0.0.1',
      httpPort: 3000,
      httpToken: undefined,
      logLevel: 'info',
      enableWrites: false,
      explorerApiUrl: undefined,
      explorerTimeoutMs: 10_000,
      explorerRetryCount: 2,
      explorerRateLimitRps: 5,
    });
  });

  it('leaves explorer tools off unless EXPLORER_API_URL is set, and validates it', () => {
    expect(loadConfig({ ...BASE, EXPLORER_API_URL: '' }).explorerApiUrl).toBeUndefined();
    expect(loadConfig({ ...BASE, EXPLORER_API_URL: 'https://elysium.kinetiq.xyz/api/v2' }).explorerApiUrl).toBe(
      'https://elysium.kinetiq.xyz/api/v2',
    );
    expect(() => loadConfig({ ...BASE, EXPLORER_API_URL: 'not a url' })).toThrow(/EXPLORER_API_URL/);
    expect(loadConfig({ ...BASE, EXPLORER_RATE_LIMIT_RPS: '2' }).explorerRateLimitRps).toBe(2);
  });

  it('requires the RPC URL and chain ID, with no built-in network', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/ELYSIUM_RPC_URL[\s\S]*ELYSIUM_CHAIN_ID/);
    expect(() => loadConfig({ ...BASE, ELYSIUM_RPC_URL: 'ftp://x' })).toThrow(/http/);
    expect(() => loadConfig({ ...BASE, ELYSIUM_CHAIN_ID: 'abc' })).toThrow(ConfigError);
  });

  it('parses numbers and booleans strictly', () => {
    const c = loadConfig({ ...BASE, MAX_LOG_BLOCK_RANGE: '500', RPC_RATE_LIMIT_RPS: '2.5', ENABLE_WRITES: '1' });
    expect(c).toMatchObject({ maxLogBlockRange: 500, rpcRateLimitRps: 2.5, enableWrites: true });
    expect(() => loadConfig({ ...BASE, ENABLE_WRITES: 'yes' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, MAX_LOG_BLOCK_RANGE: '0' })).toThrow(ConfigError);
  });

  describe('HTTP transport safety rules', () => {
    const http = { ...BASE, MCP_TRANSPORT: 'http' };

    it('allows loopback without a token', () => {
      expect(loadConfig(http).httpToken).toBeUndefined();
      expect(loadConfig({ ...http, MCP_HTTP_HOST: 'localhost' }).httpHost).toBe('localhost');
    });

    it('refuses a non-loopback host without a token', () => {
      expect(() => loadConfig({ ...http, MCP_HTTP_HOST: '0.0.0.0' })).toThrow(/MCP_HTTP_TOKEN must be set/);
      expect(loadConfig({ ...http, MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_TOKEN: TOKEN }).httpToken).toBe(TOKEN);
    });

    it('requires a token when writes are enabled over HTTP, even on loopback', () => {
      expect(() => loadConfig({ ...http, ENABLE_WRITES: 'true' })).toThrow(/ENABLE_WRITES=true over HTTP/);
      expect(loadConfig({ ...http, ENABLE_WRITES: 'true', MCP_HTTP_TOKEN: TOKEN }).enableWrites).toBe(true);
      // stdio is unaffected.
      expect(loadConfig({ ...BASE, ENABLE_WRITES: 'true' }).enableWrites).toBe(true);
    });

    it('rejects short tokens and treats an empty token as unset', () => {
      expect(() => loadConfig({ ...http, MCP_HTTP_TOKEN: 'short' })).toThrow(/at least 16/);
      expect(loadConfig({ ...http, MCP_HTTP_TOKEN: '' }).httpToken).toBeUndefined();
    });
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['192.168.1.10', false],
    ['::', false],
    ['example.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('redactUrl', () => {
  it('keeps only the origin so API keys never reach logs', () => {
    expect(redactUrl('https://rpc.example.com/v1/SECRET?key=abc')).toBe('https://rpc.example.com');
  });
});
