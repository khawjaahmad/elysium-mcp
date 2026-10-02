import { inspect } from 'node:util';
import {
  encodeErrorResult,
  encodeFunctionData,
  keccak256,
  numberToHex,
  parseAbi,
  parseEther,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { sendNative } from '../../src/tools/sendNative.js';
import { createHarness, expectError, expectOk, TEST_ENV, testConfig } from './helpers/harness.js';
import {
  ALICE,
  BOB,
  HANG,
  HttpFailure,
  rpcBlock,
  rpcReceipt,
  RpcFailure,
  rpcTransaction,
  TOKEN,
  type Handler,
} from './helpers/rpc.js';

// Anvil's first well-known test key. Never use it with real funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Loaded the way the server loads it, so the leak tests cover the real account object.
const account = loadConfig({ ...TEST_ENV, ENABLE_WRITES: 'true', ELYSIUM_PRIVATE_KEY: KEY }).writeAccount!;
const SIGNER = account.address;

const ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function deposit() payable',
]);
const TRANSFER = { to: TOKEN, abi: ABI, functionName: 'transfer', args: [BOB, '5'] };

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** A mock node that accepts writes: nonce 7 rising after each send, 1 HYPE balance, 0.01 gwei base fee. */
function writeNode(overrides: Record<string, Handler> = {}) {
  let nonce = 7;
  const sent: Hex[] = [];
  const handlers: Record<string, Handler> = {
    eth_call: () => '0x',
    eth_estimateGas: () => '0x5208', // 21,000
    eth_maxPriorityFeePerGas: () => '0x0',
    eth_gasPrice: () => '0x989680',
    eth_getBlockByNumber: () => rpcBlock(100, 1_790_000_000),
    eth_getTransactionCount: () => numberToHex(nonce),
    eth_getBalance: () => numberToHex(parseEther('1')),
    eth_sendRawTransaction: ([raw]) => {
      sent.push(raw as Hex);
      nonce++;
      return keccak256(raw as Hex);
    },
    eth_getTransactionReceipt: ([hash]) => rpcReceipt({ transactionHash: hash, from: SIGNER, to: BOB }),
    // Lookup after a failed send: by default the node does not have it.
    eth_getTransactionByHash: () => null,
    ...overrides,
  };
  return { handlers, sent };
}

describe('write tools', () => {
  let h: Harness | undefined;
  let logs: string[] = [];
  afterEach(async () => {
    await h?.close();
    h = undefined;
    logs = [];
  });

  const setup = async (
    nodeOverrides: Record<string, Handler> = {},
    config: Partial<Config> = {},
    options: Parameters<typeof createHarness>[2] = {},
  ) => {
    const node = writeNode(nodeOverrides);
    h = await createHarness(
      node.handlers,
      { enableWrites: true, writeAccount: account, writeReceiptTimeoutMs: 50, ...config },
      { logger: createLogger('debug', (line) => logs.push(line)), ...options },
    );
    return { h, sent: node.sent };
  };
  const sendRaw = () => h!.rpc.count('eth_sendRawTransaction');

  describe('registration', () => {
    it('registers no write tools unless ENABLE_WRITES is on', async () => {
      h = await createHarness({});
      const names = (await h.mcp.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(8);
      expect(names).not.toContain('send_native');
      expect(names).not.toContain('write_contract');
      expect((await h.call('send_native', { to: BOB, value: '1', dry_run: false })).ok).toBe(false);
      expect(h.rpc.calls).toHaveLength(0);
    });

    it('registers both write tools as destructive when it is on', async () => {
      await setup();
      const tools = (await h!.mcp.listTools()).tools;
      const writes = tools.filter((t) => ['send_native', 'write_contract'].includes(t.name));
      expect(writes).toHaveLength(2);
      for (const t of writes) expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tools.filter((t) => !writes.includes(t)).every((t) => t.annotations?.readOnlyHint)).toBe(true);
    });

    it('refuses with WRITES_DISABLED if a write handler runs while writes are off', async () => {
      const ctx = {
        client: {} as never,
        config: testConfig(),
        guard: { ensure: async () => {} },
        logger: createLogger('debug', (l) => logs.push(l)),
      };
      await expect(sendNative.handler({ to: BOB, value: '1', dry_run: false }, ctx)).rejects.toMatchObject({
        code: 'WRITES_DISABLED',
      });
    });
  });

  describe('send_native', () => {
    it('defaults to a dry run that simulates from the signer and sends nothing', async () => {
      await setup();
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1000' }));
      expect(data).toMatchObject({
        dryRun: true,
        status: 'dry_run',
        hash: null,
        receipt: null,
        transaction: {
          chainId: 99801,
          from: SIGNER,
          to: BOB,
          value: { wei: '1000' },
          nonce: 7,
          gasLimit: '25200', // 21,000 + 20%
          maxFeePerGas: { wei: '12000000' }, // base fee × 1.2
          maxFee: { wei: String(25_200n * 12_000_000n) },
        },
        simulation: { returnData: '0x', gasEstimate: '21000' },
      });
      const call = h!.rpc.calls.find((c) => c.method === 'eth_call')!;
      expect((call.params[0] as { from: string }).from.toLowerCase()).toBe(SIGNER.toLowerCase());
      expect(sendRaw()).toBe(0);
    });

    it('signs with the configured key for chain 99801, sends, and reports the receipt', async () => {
      const { sent } = await setup();
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1000', dry_run: false }));
      expect(sent).toHaveLength(1);
      const tx = parseTransaction(sent[0]!);
      expect(tx).toMatchObject({ chainId: 99801, nonce: 7, to: BOB.toLowerCase(), value: 1000n, gas: 25_200n });
      expect(await recoverTransactionAddress({ serializedTransaction: sent[0] as never })).toBe(SIGNER);
      expect(data).toMatchObject({
        dryRun: false,
        status: 'success',
        hash: keccak256(sent[0]!),
        receipt: { blockNumber: '100', gasUsed: '21000', fee: { wei: String(21_000n * 10_000_000n), symbol: 'HYPE' } },
      });
    });

    it('refuses a value above MAX_SEND_HYPE before touching the node', async () => {
      await setup({}, { maxSendWei: 1000n });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1001', dry_run: false }));
      expect(error).toMatchObject({ code: 'VALUE_CAP_EXCEEDED', details: { value: '1001', max: '1000' } });
      expect(h!.rpc.calls).toHaveLength(0);
      expectOk(await h!.call('send_native', { to: BOB, value: '1000' }));
    });

    it('refuses when gas limit × max fee per gas exceeds MAX_FEE_HYPE', async () => {
      await setup({ eth_estimateGas: () => numberToHex(100_000_000n) });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(error).toMatchObject({ code: 'FEE_CAP_EXCEEDED', details: { max: parseEther('0.001').toString() } });
      expect(sendRaw()).toBe(0);
    });

    it('refuses destinations outside WRITE_ALLOWLIST', async () => {
      await setup({}, { writeAllowlist: [BOB] });
      const error = expectError(await h!.call('send_native', { to: ALICE, value: '1', dry_run: false }));
      expect(error.code).toBe('ADDRESS_NOT_ALLOWED');
      expect(h!.rpc.calls).toHaveLength(0);
      expectOk(await h!.call('send_native', { to: BOB.toLowerCase(), value: '1' }));
    });

    it('refuses when the node serves any chain other than 99801', async () => {
      await setup({ eth_chainId: () => numberToHex(1) });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(error).toMatchObject({ code: 'CHAIN_MISMATCH', details: { expected: 99801, actual: 1 } });
      expect(h!.rpc.count('eth_call')).toBe(0);
      expect(sendRaw()).toBe(0);
    });

    it('does not send when the simulation reverts, and returns the decoded revert', async () => {
      const data = encodeErrorResult({
        abi: parseAbi(['error Error(string)']),
        errorName: 'Error',
        args: ['not allowed'],
      });
      await setup({
        eth_call: () => {
          throw new RpcFailure(3, 'execution reverted: not allowed', data);
        },
      });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(error).toMatchObject({ code: 'EXECUTION_REVERTED', details: { revert: { reason: 'not allowed' } } });
      expect(error.message).toMatch(/Nothing was sent/);
      expect(sendRaw()).toBe(0);
    });

    it('reports INSUFFICIENT_FUNDS from the balance check and from the node', async () => {
      await setup({ eth_getBalance: () => '0x1' });
      expect(expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false })).code).toBe(
        'INSUFFICIENT_FUNDS',
      );
      await h!.close();
      await setup({
        eth_call: () => {
          throw new RpcFailure(-32000, 'insufficient funds for gas * price + value: have 0 want 1');
        },
      });
      expect(expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false })).code).toBe(
        'INSUFFICIENT_FUNDS',
      );
      expect(sendRaw()).toBe(0);
    });

    it('maps nonce rejections to NONCE_ERROR and includes the transaction hash', async () => {
      await setup({
        eth_sendRawTransaction: () => {
          throw new RpcFailure(-32000, 'nonce too low: next nonce 8, tx nonce 7');
        },
      });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      const raw = h!.rpc.calls.find((c) => c.method === 'eth_sendRawTransaction')!.params[0] as Hex;
      expect(error).toMatchObject({ code: 'NONCE_ERROR', details: { hash: keccak256(raw) } });
    });

    it('reports a transaction that reverted on-chain, with its fee', async () => {
      await setup({ eth_getTransactionReceipt: ([hash]) => rpcReceipt({ transactionHash: hash, status: '0x0' }) });
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(data).toMatchObject({ status: 'reverted', receipt: { gasUsed: '21000' } });
    });

    it('returns pending with the hash when no receipt arrives in time', async () => {
      const { sent } = await setup({ eth_getTransactionReceipt: () => null });
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(data).toMatchObject({ status: 'pending', hash: keccak256(sent[0]!), receipt: null });
      expect(data.note).toMatch(/Do not resend/);
    });

    it('sends one transaction at a time, so concurrent sends get different nonces', async () => {
      const { sent } = await setup();
      await Promise.all([
        h!.call('send_native', { to: BOB, value: '1', dry_run: false }),
        h!.call('send_native', { to: BOB, value: '2', dry_run: false }),
      ]);
      expect(sent.map((raw) => parseTransaction(raw).nonce).sort()).toEqual([7, 8]);
    });
  });

  describe('after signing', () => {
    const throwing = (err: RpcFailure) => () => {
      throw err;
    };
    /** Distinct signed transactions the node was asked to send. More than one would be a double send. */
    const signedTxs = () => [
      ...new Set(h!.rpc.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.params[0] as Hex)),
    ];
    const found: Handler = ([hash]) => rpcTransaction({ hash, from: SIGNER, to: BOB });

    it('continues as sent when the send times out but the node has the transaction', async () => {
      await setup({ eth_sendRawTransaction: () => HANG, eth_getTransactionByHash: found });
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(signedTxs()).toHaveLength(1);
      expect(data).toMatchObject({ status: 'success', hash: keccak256(signedTxs()[0]!) });
    });

    it('returns a non-retryable SEND_STATUS_UNKNOWN with the hash when the send times out and is not found', async () => {
      await setup({ eth_sendRawTransaction: () => HANG });
      const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(error).toMatchObject({
        code: 'SEND_STATUS_UNKNOWN',
        retryable: false,
        details: { hash: keccak256(signedTxs()[0]!), sendError: { code: 'RPC_TIMEOUT' } },
      });
      expect(error.hint).toMatch(/Do not retry yet/);
      expect(signedTxs()).toHaveLength(1);
    });

    it('treats "already known" on a transport-level retry as sent', async () => {
      let n = 0;
      await setup({
        eth_sendRawTransaction: () =>
          ++n === 1 ? new HttpFailure(503) : throwing(new RpcFailure(-32000, 'already known'))(),
      });
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(h!.rpc.count('eth_sendRawTransaction')).toBe(2);
      expect(signedTxs()).toHaveLength(1);
      expect(data).toMatchObject({ status: 'success', hash: keccak256(signedTxs()[0]!) });
    });

    it('treats a retried send that comes back "nonce too low" as sent when the node has it', async () => {
      let n = 0;
      await setup({
        eth_sendRawTransaction: () =>
          ++n === 1
            ? new HttpFailure(503)
            : throwing(new RpcFailure(-32000, 'nonce too low: next nonce 8, tx nonce 7'))(),
        eth_getTransactionByHash: found,
      });
      const data = expectOk(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
      expect(data).toMatchObject({ status: 'success', hash: keccak256(signedTxs()[0]!) });
    });

    it.each([
      ['timeout', () => HANG, () => null, 'SEND_STATUS_UNKNOWN'],
      ['HTTP 503', () => new HttpFailure(503), () => null, 'SEND_STATUS_UNKNOWN'],
      ['HTTP 429', () => new HttpFailure(429), () => null, 'SEND_STATUS_UNKNOWN'],
      [
        'JSON-RPC rate limit',
        throwing(new RpcFailure(-32005, 'rate limit exceeded')),
        () => null,
        'SEND_STATUS_UNKNOWN',
      ],
      ['timeout, and the lookup fails too', () => HANG, () => new HttpFailure(503), 'SEND_STATUS_UNKNOWN'],
      ['nonce too low', throwing(new RpcFailure(-32000, 'nonce too low')), () => null, 'NONCE_ERROR'],
      [
        'underpriced',
        throwing(new RpcFailure(-32000, 'replacement transaction underpriced')),
        () => null,
        'NONCE_ERROR',
      ],
      [
        'insufficient funds',
        throwing(new RpcFailure(-32000, 'insufficient funds for gas')),
        () => null,
        'INSUFFICIENT_FUNDS',
      ],
      [
        'other rejection',
        throwing(new RpcFailure(-32000, 'max fee per gas less than base fee')),
        () => null,
        'RPC_ERROR',
      ],
      [
        'nonce too low, lookup fails',
        throwing(new RpcFailure(-32000, 'nonce too low')),
        () => new HttpFailure(503),
        'SEND_STATUS_UNKNOWN',
      ],
    ] as [string, Handler, Handler, string][])(
      'no error after signing is retryable: %s',
      async (_label, send, lookup, code) => {
        await setup({ eth_sendRawTransaction: send, eth_getTransactionByHash: lookup });
        const error = expectError(await h!.call('send_native', { to: BOB, value: '1', dry_run: false }));
        expect(error).toMatchObject({ code, retryable: false, details: { hash: keccak256(signedTxs()[0]!) } });
        expect(signedTxs()).toHaveLength(1);
      },
    );
  });

  describe('write_contract', () => {
    it('dry run returns the call decoded from the exact call data, and sends nothing', async () => {
      await setup();
      const data = expectOk(await h!.call('write_contract', TRANSFER));
      expect(data).toMatchObject({
        status: 'dry_run',
        call: {
          functionName: 'transfer',
          signature: 'transfer(address,uint256)',
          args: [
            { name: 'to', type: 'address', value: BOB },
            { name: 'amount', type: 'uint256', value: '5' },
          ],
        },
        transaction: {
          to: TOKEN,
          data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }),
          value: { wei: '0' },
        },
      });
      expect(sendRaw()).toBe(0);
    });

    it('sends the call and never contacts the explorer', async () => {
      const { sent } = await setup({}, {}, { explorer: {} });
      expectOk(await h!.call('write_contract', { ...TRANSFER, dry_run: false }));
      expect(sent).toHaveLength(1);
      expect(h!.explorer!.calls).toHaveLength(0);
    });

    it('refuses view functions and value sent to non-payable functions', async () => {
      await setup();
      const view = expectError(
        await h!.call('write_contract', { to: TOKEN, abi: ABI, functionName: 'balanceOf', args: [BOB] }),
      );
      expect(view).toMatchObject({ code: 'INVALID_INPUT', hint: expect.stringMatching(/read_contract/) });
      const nonPayable = expectError(await h!.call('write_contract', { ...TRANSFER, value: '1' }));
      expect(nonPayable.message).toMatch(/not payable/);
      expectOk(await h!.call('write_contract', { to: TOKEN, abi: ABI, functionName: 'deposit', value: '1' }));
    });

    it('applies the allowlist and value cap to the contract call', async () => {
      await setup({}, { writeAllowlist: [BOB], maxSendWei: 10n });
      expect(expectError(await h!.call('write_contract', TRANSFER)).code).toBe('ADDRESS_NOT_ALLOWED');
      expect(
        expectError(await h!.call('write_contract', { to: BOB, abi: ABI, functionName: 'deposit', value: '11' })).code,
      ).toBe('VALUE_CAP_EXCEEDED');
    });
  });

  describe('audit log', () => {
    it('writes one line per attempt with from, to, value, function, dry_run, outcome and hash', async () => {
      const { sent } = await setup({}, { maxSendWei: 1000n });
      await h!.call('send_native', { to: BOB, value: '1' });
      await h!.call('send_native', { to: BOB, value: '5000', dry_run: false });
      await h!.call('write_contract', { ...TRANSFER, dry_run: false });
      const audit = logs.filter((l) => l.includes('write-audit')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
      expect(audit).toEqual([
        {
          tool: 'send_native',
          from: SIGNER,
          to: BOB,
          value: '1',
          function: null,
          dryRun: true,
          outcome: 'dry_run',
          hash: null,
        },
        {
          tool: 'send_native',
          from: SIGNER,
          to: BOB,
          value: '5000',
          function: null,
          dryRun: false,
          outcome: 'error:VALUE_CAP_EXCEEDED',
          hash: null,
        },
        {
          tool: 'write_contract',
          from: SIGNER,
          to: TOKEN,
          value: '0',
          function: 'transfer',
          dryRun: false,
          outcome: 'success',
          hash: keccak256(sent[0]!),
        },
      ]);
    });
  });

  describe('private key', () => {
    it('is never a tool input: no write tool takes a key, and extra arguments cannot change the signer', async () => {
      const { sent } = await setup();
      const tools = (await h!.mcp.listTools()).tools.filter((t) => ['send_native', 'write_contract'].includes(t.name));
      for (const t of tools) {
        expect(Object.keys(t.inputSchema.properties ?? {}).join(' ')).not.toMatch(
          /key|secret|mnemonic|seed|private|signer|account|from/i,
        );
      }
      expectOk(
        await h!.call('send_native', { to: BOB, value: '1', dry_run: false, privateKey: OTHER_KEY, from: ALICE }),
      );
      expect(await recoverTransactionAddress({ serializedTransaction: sent[0] as never })).toBe(SIGNER);
    });

    it('never appears in logs, results, errors, tool listings or the config', async () => {
      const outputs: unknown[] = [];
      const run = async (name: string, args: Record<string, unknown>) => outputs.push(await h!.call(name, args));

      await setup({}, { maxSendWei: 1000n, writeAllowlist: [BOB, TOKEN] });
      outputs.push(await h!.mcp.listTools(), h!.mcp.getInstructions());
      await run('send_native', { to: BOB, value: '1' });
      await run('send_native', { to: BOB, value: '1', dry_run: false });
      await run('send_native', { to: BOB, value: '5000', dry_run: false });
      await run('send_native', { to: ALICE, value: '1', dry_run: false });
      await run('send_native', { to: 'not an address', value: '1' });
      await run('write_contract', { ...TRANSFER, dry_run: false });
      await run('write_contract', { to: TOKEN, abi: ABI, functionName: 'balanceOf', args: [BOB] });
      await h!.close();

      await setup({
        eth_call: () => {
          throw new RpcFailure(3, 'execution reverted');
        },
      });
      await run('send_native', { to: BOB, value: '1', dry_run: false });
      await h!.close();

      await setup({
        eth_sendRawTransaction: () => {
          throw new RpcFailure(-32000, 'nonce too low');
        },
        eth_estimateGas: () => {
          throw new RpcFailure(-32000, 'insufficient funds for gas * price + value');
        },
      });
      await run('send_native', { to: BOB, value: '1', dry_run: false });

      const config = testConfig({ enableWrites: true, writeAccount: account });
      const haystack = [
        JSON.stringify(outputs),
        logs.join('\n'),
        JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        inspect(config, { depth: 10, showHidden: true }),
      ]
        .join('\n')
        .toLowerCase();
      expect(logs.filter((l) => l.includes('write-audit')).length).toBeGreaterThanOrEqual(9);
      expect(haystack).toContain(SIGNER.toLowerCase());
      expect(haystack).not.toContain(KEY.slice(2).toLowerCase());
    });
  });
});
