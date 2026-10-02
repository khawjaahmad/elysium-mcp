import {
  keccak256,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { z } from 'zod';
import { ELYSIUM_TESTNET_CHAIN_ID } from '../chain.js';
import type { Config } from '../config.js';
import { ToolError, extractRevert, rpcMessage, toToolError } from '../errors.js';
import { gasPrice, nativeAmount } from '../format.js';
import type { ToolContext } from './define.js';
import { gasPriceSchema, nativeAmountSchema } from './schemas.js';
import { decodeRevert } from './simulateCall.js';

/** Added on top of eth_estimateGas, which on Arbitrum includes a parent-chain data cost that can move. */
const GAS_LIMIT_BUFFER_PERCENT = 20n;
const RECEIPT_POLL_MS = 500;

export const dryRunInput = z
  .boolean()
  .optional()
  .describe(
    'Default true: check and simulate, then return exactly what would be sent, without signing or sending. ' +
      'Set false to send. This guards against accidents; it is not a human approval step.',
  );

export interface WriteRequest {
  to: Address;
  value: bigint;
  data?: Hex;
  /** Used to decode a simulation revert. */
  abi?: Abi;
  dryRun: boolean;
}

export const writeOutputSchema = {
  dryRun: z.boolean(),
  status: z
    .enum(['dry_run', 'success', 'reverted', 'pending'])
    .describe(
      'dry_run: nothing was sent. success / reverted: mined, per the receipt. pending: sent, but no receipt yet; ' +
        'do not resend, check get_transaction with the hash.',
    ),
  hash: z.string().nullable().describe('Transaction hash, once sent.'),
  transaction: z.object({
    chainId: z.number(),
    from: z.string(),
    to: z.string(),
    value: nativeAmountSchema,
    data: z.string(),
    nonce: z.number(),
    gasLimit: z.string().describe(`eth_estimateGas plus ${GAS_LIMIT_BUFFER_PERCENT}%.`),
    maxFeePerGas: gasPriceSchema,
    maxPriorityFeePerGas: gasPriceSchema,
    maxFee: nativeAmountSchema.describe('gasLimit × maxFeePerGas: the most this transaction can cost in fees.'),
  }),
  simulation: z.object({
    returnData: z.string().describe('eth_call return data from the simulation, run from the signing address.'),
    gasEstimate: z.string(),
  }),
  receipt: z
    .object({
      blockNumber: z.string(),
      gasUsed: z.string(),
      effectiveGasPrice: gasPriceSchema,
      fee: nativeAmountSchema,
    })
    .nullable(),
  note: z.string(),
};

type WriteOutput = z.infer<z.ZodObject<typeof writeOutputSchema>>;

/** Returns the signing account, or refuses if writes are off (defence in depth: the tools are not registered then). */
function writeAccount(config: Config): LocalAccount {
  if (!config.enableWrites || !config.writeAccount) {
    throw new ToolError('WRITES_DISABLED', 'Write tools are disabled on this server.', {
      hint: 'The operator must set ENABLE_WRITES=true and ELYSIUM_PRIVATE_KEY.',
    });
  }
  return config.writeAccount;
}

/** Maps node errors that have a write-specific meaning; everything else is classified as usual. */
export function classifyWriteError(err: unknown): ToolError {
  const e = toToolError(err);
  if (e.retryable) return e;
  const message = rpcMessage(err);
  if (/insufficient funds/i.test(message)) {
    return new ToolError('INSUFFICIENT_FUNDS', `The signing account cannot pay for this transaction: ${message}`, {
      hint: 'Fund the account with HYPE, or lower the value.',
      cause: err,
    });
  }
  if (/nonce too (low|high)|invalid nonce|replacement transaction underpriced/i.test(message)) {
    return new ToolError('NONCE_ERROR', `The node rejected the transaction nonce: ${message}`, {
      hint: 'Another transaction from this account may be pending. Check recent transactions before trying again.',
      cause: err,
    });
  }
  return e;
}

function simulationError(err: unknown, abi: Abi | undefined): ToolError {
  const e = classifyWriteError(err);
  if (e.code === 'INSUFFICIENT_FUNDS' || e.retryable) return e;
  const revert = extractRevert(err);
  if (!revert) return e;
  const decoded = decodeRevert(revert, abi);
  return new ToolError(
    'EXECUTION_REVERTED',
    `The simulation reverted${decoded.reason ? `: ${decoded.reason}` : ''}. Nothing was sent.`,
    {
      hint: 'Fix the arguments or value; a transaction that reverts in simulation would fail on-chain and still cost gas.',
      details: { revert: decoded },
    },
  );
}

/**
 * Serialises sends within this process, so two calls cannot read the same
 * pending nonce. ponytail: per process only; two servers sharing a key can
 * still collide (they get NONCE_ERROR).
 */
let sendQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(fn, fn);
  sendQueue = run.catch(() => undefined);
  return run;
}

/**
 * Sends a signed transaction and returns its hash. From here on no error is
 * retryable: the node may have accepted the transaction even if the request
 * failed, and a retry would sign a second transaction with a fresh nonce.
 */
async function sendSigned(ctx: ToolContext, serialized: Hex): Promise<Hash> {
  // The hash is known before sending, so a failed send can still be looked up.
  const hash = keccak256(serialized);
  let sendError: unknown;
  try {
    return (await ctx.client.request({ method: 'eth_sendRawTransaction', params: [serialized] })) as Hash;
  } catch (err) {
    // The node already holds this exact transaction, e.g. after a transport-level retry.
    if (/already known/i.test(rpcMessage(err))) return hash;
    sendError = err;
  }

  // Look it up after any failure, not only uncertain ones: if a timed-out first
  // attempt was accepted and mined, the transport's retry gets "nonce too low".
  let lookupFailed = false;
  try {
    await ctx.client.getTransaction({ hash });
    return hash;
  } catch (err) {
    lookupFailed = toToolError(err).code !== 'NOT_FOUND';
  }

  const e = classifyWriteError(sendError);
  if (!e.retryable && !lookupFailed) {
    // A definite rejection, and the node does not have the transaction.
    throw new ToolError(e.code, e.message, {
      ...(e.hint === undefined ? {} : { hint: e.hint }),
      details: { ...e.details, hash },
      cause: sendError,
    });
  }
  throw new ToolError(
    'SEND_STATUS_UNKNOWN',
    `Sending failed (${e.message}), and it is unknown whether the node received the transaction.`,
    {
      hint: `Do not retry yet: a retry signs a new transaction and could send twice. Check get_transaction for ${hash} first.`,
      details: { hash, sendError: { code: e.code, message: e.message } },
      cause: sendError,
    },
  );
}

/** Polls for the receipt until it appears or the timeout passes. Errors while polling are not fatal: the transaction is already sent. */
async function waitForReceipt(ctx: ToolContext, hash: Hash): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + ctx.config.writeReceiptTimeoutMs;
  for (;;) {
    try {
      return await ctx.client.getTransactionReceipt({ hash });
    } catch {
      // Not mined yet, or a transient RPC failure.
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(RECEIPT_POLL_MS, left)));
  }
}

/**
 * The shared write path: allowlist, value cap, chain check, simulation, fee
 * cap and balance check, then either a dry-run preview or sign, send and wait.
 */
export async function executeWrite(req: WriteRequest, ctx: ToolContext): Promise<WriteOutput> {
  const { client, config } = ctx;
  const account = writeAccount(config);

  if (config.writeAllowlist && !config.writeAllowlist.some((a) => a.toLowerCase() === req.to.toLowerCase())) {
    throw new ToolError('ADDRESS_NOT_ALLOWED', `${req.to} is not in WRITE_ALLOWLIST.`, {
      hint: 'Only addresses in WRITE_ALLOWLIST can receive transactions from this server.',
      details: { to: req.to },
    });
  }
  if (req.value > config.maxSendWei) {
    throw new ToolError(
      'VALUE_CAP_EXCEEDED',
      `The value ${nativeAmount(client.chain, req.value).formatted} HYPE exceeds MAX_SEND_HYPE (${nativeAmount(client.chain, config.maxSendWei).formatted} HYPE).`,
      { details: { value: req.value.toString(), max: config.maxSendWei.toString() } },
    );
  }

  const prepareAndMaybeSend = async (): Promise<WriteOutput> => {
    // Checked fresh on every write, not cached like the read tools' check.
    const chainId = await client.getChainId();
    if (chainId !== ELYSIUM_TESTNET_CHAIN_ID) {
      throw new ToolError(
        'CHAIN_MISMATCH',
        `The RPC endpoint serves chain ID ${chainId}; writes are only allowed on ${ELYSIUM_TESTNET_CHAIN_ID}.`,
        { details: { expected: ELYSIUM_TESTNET_CHAIN_ID, actual: chainId } },
      );
    }

    const from = account.address;
    const call = { account: from, to: req.to, value: req.value, ...(req.data ? { data: req.data } : {}) };
    let returnData: Hex;
    try {
      returnData = (await client.call(call)).data ?? '0x';
    } catch (err) {
      throw simulationError(err, req.abi);
    }

    let gasEstimate: bigint,
      fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
      nonce: number,
      balance: bigint;
    try {
      [gasEstimate, fees, nonce, balance] = await Promise.all([
        client.estimateGas(call),
        client.estimateFeesPerGas(),
        client.getTransactionCount({ address: from, blockTag: 'pending' }),
        client.getBalance({ address: from }),
      ]);
    } catch (err) {
      throw simulationError(err, req.abi);
    }

    const gasLimit = gasEstimate + (gasEstimate * GAS_LIMIT_BUFFER_PERCENT) / 100n;
    const maxFee = gasLimit * fees.maxFeePerGas;
    if (maxFee > config.maxFeeWei) {
      throw new ToolError(
        'FEE_CAP_EXCEEDED',
        `The maximum fee ${nativeAmount(client.chain, maxFee).formatted} HYPE exceeds MAX_FEE_HYPE (${nativeAmount(client.chain, config.maxFeeWei).formatted} HYPE).`,
        {
          details: {
            gasLimit: gasLimit.toString(),
            maxFeePerGas: fees.maxFeePerGas.toString(),
            maxFee: maxFee.toString(),
            max: config.maxFeeWei.toString(),
          },
        },
      );
    }
    if (balance < req.value + maxFee) {
      throw new ToolError(
        'INSUFFICIENT_FUNDS',
        `The signing account holds ${nativeAmount(client.chain, balance).formatted} HYPE but this transaction may need ` +
          `${nativeAmount(client.chain, req.value + maxFee).formatted} HYPE (value + maximum fee).`,
        {
          hint: 'Fund the account with HYPE, or lower the value.',
          details: { balance: balance.toString(), required: (req.value + maxFee).toString() },
        },
      );
    }

    const tx: TransactionSerializableEIP1559 = {
      type: 'eip1559',
      chainId: ELYSIUM_TESTNET_CHAIN_ID,
      to: req.to,
      value: req.value,
      data: req.data ?? '0x',
      nonce,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    const base = {
      dryRun: req.dryRun,
      transaction: {
        chainId: ELYSIUM_TESTNET_CHAIN_ID,
        from,
        to: req.to,
        value: nativeAmount(client.chain, req.value),
        data: tx.data!,
        nonce,
        gasLimit: gasLimit.toString(),
        maxFeePerGas: gasPrice(fees.maxFeePerGas),
        maxPriorityFeePerGas: gasPrice(fees.maxPriorityFeePerGas),
        maxFee: nativeAmount(client.chain, maxFee),
      },
      simulation: { returnData, gasEstimate: gasEstimate.toString() },
    };

    if (req.dryRun) {
      return {
        ...base,
        status: 'dry_run',
        hash: null,
        receipt: null,
        note: 'Nothing was sent. Call again with dry_run=false to send; nonce and fees are re-read at that point.',
      };
    }

    const serialized = await account.signTransaction(tx);
    const hash = await sendSigned(ctx, serialized);

    const receipt = await waitForReceipt(ctx, hash);
    if (!receipt) {
      return {
        ...base,
        status: 'pending',
        hash,
        receipt: null,
        note: `Sent, but no receipt within ${config.writeReceiptTimeoutMs} ms. Do not resend; check get_transaction with this hash.`,
      };
    }
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    return {
      ...base,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      hash,
      receipt: {
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: gasPrice(receipt.effectiveGasPrice),
        fee: nativeAmount(client.chain, fee),
      },
      note:
        receipt.status === 'success'
          ? 'Sent and mined successfully.'
          : 'Sent and mined, but it reverted on-chain (state changed after the simulation). The fee was still paid.',
    };
  };

  return req.dryRun ? prepareAndMaybeSend() : oneAtATime(prepareAndMaybeSend);
}

export interface AuditEntry {
  tool: string;
  to: unknown;
  value: unknown;
  functionName: string | null;
  dryRun: boolean;
}

/**
 * Runs one write attempt and logs exactly one audit line for it, whatever
 * the outcome. The line carries the signing address, never the key.
 */
export async function audited(
  ctx: ToolContext,
  entry: AuditEntry,
  fn: () => Promise<WriteOutput>,
): Promise<WriteOutput> {
  let outcome = 'error:INTERNAL_ERROR';
  let hash: string | null = null;
  try {
    const result = await fn();
    outcome = result.status;
    hash = result.hash;
    return result;
  } catch (err) {
    const e = toToolError(err);
    outcome = `error:${e.code}`;
    hash = typeof e.details?.hash === 'string' ? e.details.hash : null;
    throw e;
  } finally {
    ctx.logger.warn(
      `write-audit ${JSON.stringify({
        tool: entry.tool,
        from: ctx.config.writeAccount?.address ?? null,
        to: entry.to ?? null,
        value: entry.value ?? null,
        function: entry.functionName,
        dryRun: entry.dryRun,
        outcome,
        hash,
      })}`,
    );
  }
}
