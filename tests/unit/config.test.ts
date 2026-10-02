import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig, redactUrl } from '../../src/config.js';

const BASE = { ELYSIUM_RPC_URL: 'https://testnet-rpc.elysium.kinetiq.xyz', ELYSIUM_CHAIN_ID: '99801' };
const TOKEN = 'a-sufficiently-long-token';
// Anvil's first well-known test key. Never use it with real funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WRITES = { ENABLE_WRITES: 'true', ELYSIUM_PRIVATE_KEY: KEY };

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
      writeAccount: undefined,
      maxSendWei: 10_000_000_000_000_000n, // 0.01 HYPE
      maxFeeWei: 1_000_000_000_000_000n, // 0.001 HYPE
      writeAllowlist: undefined,
      writeReceiptTimeoutMs: 30_000,
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
    const c = loadConfig({
      ...BASE,
      ...WRITES,
      MAX_LOG_BLOCK_RANGE: '500',
      RPC_RATE_LIMIT_RPS: '2.5',
      ENABLE_WRITES: '1',
    });
    expect(c).toMatchObject({ maxLogBlockRange: 500, rpcRateLimitRps: 2.5, enableWrites: true });
    expect(() => loadConfig({ ...BASE, ENABLE_WRITES: 'yes' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, MAX_LOG_BLOCK_RANGE: '0' })).toThrow(ConfigError);
  });

  describe('write settings', () => {
    it('requires a valid private key when writes are enabled, and never echoes it', () => {
      expect(() => loadConfig({ ...BASE, ENABLE_WRITES: 'true' })).toThrow(/requires ELYSIUM_PRIVATE_KEY/);
      for (const bad of [KEY.slice(0, -2), `${KEY}00`, KEY.replace('ac', 'zz'), `0x${'0'.repeat(64)}`]) {
        let message = '';
        try {
          loadConfig({ ...BASE, ENABLE_WRITES: 'true', ELYSIUM_PRIVATE_KEY: bad });
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigError);
          expect((err as Error).cause).toBeUndefined();
          message = (err as Error).message;
        }
        expect(message).toMatch(/ELYSIUM_PRIVATE_KEY/);
        expect(message.toLowerCase()).not.toContain(bad.replace(/^0x/, '').toLowerCase().slice(0, 16));
      }
    });

    it('loads the signing account only when writes are enabled', () => {
      const c = loadConfig({ ...BASE, ...WRITES });
      expect(c.writeAccount?.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      expect(loadConfig({ ...BASE, ELYSIUM_PRIVATE_KEY: KEY }).writeAccount).toBeUndefined();
      // The key also loads without the 0x prefix.
      expect(loadConfig({ ...BASE, ...WRITES, ELYSIUM_PRIVATE_KEY: KEY.slice(2) }).writeAccount?.address).toBe(
        c.writeAccount?.address,
      );
    });

    it('refuses writes on any chain other than 99801', () => {
      expect(() => loadConfig({ ...BASE, ...WRITES, ELYSIUM_CHAIN_ID: '1' })).toThrow(/only allowed on chain 99801/);
      // Reads on another chain are still fine.
      expect(loadConfig({ ...BASE, ELYSIUM_CHAIN_ID: '1' }).chainId).toBe(1);
    });

    it('parses the caps as HYPE and the allowlist as addresses', () => {
      const c = loadConfig({
        ...BASE,
        MAX_SEND_HYPE: '1.5',
        MAX_FEE_HYPE: '0',
        WRITE_ALLOWLIST: ' 0x1111111111111111111111111111111111111111 ,0x2222222222222222222222222222222222222222',
      });
      expect(c).toMatchObject({ maxSendWei: 1_500_000_000_000_000_000n, maxFeeWei: 0n });
      expect(c.writeAllowlist).toEqual([
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
      ]);
      expect(loadConfig({ ...BASE, WRITE_ALLOWLIST: '' }).writeAllowlist).toBeUndefined();
      expect(() => loadConfig({ ...BASE, WRITE_ALLOWLIST: '0x1234' })).toThrow(/WRITE_ALLOWLIST/);
      expect(() => loadConfig({ ...BASE, MAX_SEND_HYPE: '-1' })).toThrow(/MAX_SEND_HYPE/);
      expect(() => loadConfig({ ...BASE, MAX_FEE_HYPE: '1e18' })).toThrow(/MAX_FEE_HYPE/);
    });
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
      expect(() => loadConfig({ ...http, ...WRITES })).toThrow(/ENABLE_WRITES=true over HTTP/);
      expect(loadConfig({ ...http, ...WRITES, MCP_HTTP_TOKEN: TOKEN }).enableWrites).toBe(true);
      // stdio is unaffected.
      expect(loadConfig({ ...BASE, ...WRITES }).enableWrites).toBe(true);
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
